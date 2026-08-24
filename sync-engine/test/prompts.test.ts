import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { prompts } from "../../shared/database/schema.ts";
import { PROMPT_BODY_MAXIMUM_BYTES } from "../../shared/prompt-model.ts";
import { promptPath, PROMPTS_PATH } from "../../shared/routes.ts";
import {
  createDrizzlePromptIntegration,
  type PromptIntegration,
} from "../../sync-engine/prompts.ts";
import {
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  expectResponseStatuses,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const PROMPT_ID = "018bcfe5-6800-7000-8000-000000000071";
const OTHER_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000072";
const NEXT_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000073";
const DUPLICATE_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000074";

function createSetup(maximumCount?: number) {
  const { auth, database } = createAuthenticatedTestContext();
  addTestUser(database);
  database
    .insert(prompts)
    .values({
      ...createdAuditFields(TEST_FOREIGN_USER_ID, TEST_NOW),
      body: "Secret prompt body",
      id: OTHER_PROMPT_ID,
      name: "Private prompt",
      normalizedName: "private prompt",
      userId: TEST_FOREIGN_USER_ID,
    })
    .run();
  const ids = [PROMPT_ID, NEXT_PROMPT_ID, DUPLICATE_PROMPT_ID];
  const integration = createDrizzlePromptIntegration(auth, {
    database,
    ...(maximumCount === undefined ? {} : { maximumCount }),
    now: () => TEST_NOW,
    randomId: () => takeValue(ids, "The test ran out of prompt IDs"),
  });
  return { database, integration };
}

function request(
  path: string,
  method = "GET",
  body?: Readonly<Record<string, unknown>>,
  revision?: string,
): Request {
  const result = createAuthenticatedRequest(path, body, method);
  if (revision !== undefined) {
    result.headers.set("if-match", revision);
  }
  return result;
}

function item(
  options: Readonly<{
    integration: PromptIntegration;
    method?: string;
    body?: Readonly<Record<string, unknown>>;
    revision?: string;
  }>,
): Promise<Response> | Response {
  return options.integration.item(
    request(
      promptPath(PROMPT_ID),
      options.method,
      options.body,
      options.revision,
    ),
    PROMPT_ID,
  );
}

function create(
  integration: PromptIntegration,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> | Response {
  return integration.collection(request(PROMPTS_PATH, "POST", body));
}

async function expectError(
  response: Promise<Response> | Response,
  status: number,
  error: string,
): Promise<void> {
  const resolved = await response;
  expect([resolved.status, await resolved.json()]).toEqual([status, { error }]);
}

async function createOwned(integration: PromptIntegration): Promise<void> {
  expect(
    (
      await create(integration, {
        body: "Original body",
        name: "Original name",
      })
    ).status,
  ).toBe(201);
}

describe("prompt API", () => {
  test("requires authentication and supported methods", async () => {
    const { database, integration } = createSetup();
    const unauthenticated = await Promise.all([
      Promise.resolve(
        integration.collection(new Request(`http://localhost${PROMPTS_PATH}`)),
      ),
      Promise.resolve(
        integration.item(
          new Request(`http://localhost${promptPath(PROMPT_ID)}`),
          PROMPT_ID,
        ),
      ),
    ]);
    expectResponseStatuses(unauthenticated, 401);
    const unsupported = await Promise.all([
      Promise.resolve(integration.collection(request(PROMPTS_PATH, "PUT"))),
      Promise.resolve(
        integration.item(request(promptPath(PROMPT_ID), "POST"), PROMPT_ID),
      ),
    ]);
    expectResponseStatuses(unsupported, 405);
    database.$client.close();
  });

  test("normalizes names, preserves bodies, and versions writes", async () => {
    const { database, integration } = createSetup();
    const body = "  Inspect the repository.\nKeep this spacing.  ";
    const createdResponse = await create(integration, {
      body,
      name: "  Ｉｎｓｐｅｃｔ\t\n repository  ",
    });
    const created = {
      body,
      createdAt: TEST_NOW,
      id: PROMPT_ID,
      name: "Inspect repository",
      revision: 1,
      updatedAt: TEST_NOW,
    };
    expect([createdResponse.status, await createdResponse.json()]).toEqual([
      201,
      created,
    ]);
    expect(
      await (await integration.collection(request(PROMPTS_PATH))).json(),
    ).toEqual({ prompts: [created] });
    expect(await (await item({ integration })).json()).toEqual(created);

    const updated = await item({
      body: { body: "\nUpdated without trimming\n", name: "Test" },
      integration,
      method: "PUT",
      revision: '"1"',
    });
    expect(await updated.json()).toMatchObject({ revision: 2 });
    expect(
      (await item({ integration, method: "DELETE", revision: '"2"' })).status,
    ).toBe(204);
    expect(
      database
        .select({ isDeleted: prompts.isDeleted, revision: prompts.revision })
        .from(prompts)
        .where(eq(prompts.id, PROMPT_ID))
        .get(),
    ).toEqual({ isDeleted: true, revision: 3 });
    database.$client.close();
  });

  test("requires current revisions and keeps newer writes", async () => {
    const { database, integration } = createSetup();
    await createOwned(integration);
    await expectError(
      item({
        body: { body: "No revision", name: "No" },
        integration,
        method: "PUT",
      }),
      428,
      "precondition_required",
    );
    await expectError(
      item({ integration, method: "DELETE" }),
      428,
      "precondition_required",
    );
    expect(
      (
        await item({
          body: { body: "Current body", name: "Current" },
          integration,
          method: "PUT",
          revision: '"1"',
        })
      ).status,
    ).toBe(200);
    await expectError(
      item({
        body: { body: "Stale overwrite", name: "Stale" },
        integration,
        method: "PUT",
        revision: '"1"',
      }),
      412,
      "prompt_changed",
    );
    await expectError(
      item({ integration, method: "DELETE", revision: '"1"' }),
      412,
      "prompt_changed",
    );
    database.$client.close();
  });

  test("bounds request envelopes and each owner's active count", async () => {
    const { database, integration } = createSetup(1);
    const huge = createAuthenticatedRequest(PROMPTS_PATH, undefined, "POST");
    huge.headers.set("content-type", "application/json");
    const oversized = new Request(huge, {
      body: JSON.stringify({
        body: "x".repeat(PROMPT_BODY_MAXIMUM_BYTES + 2_000),
        name: "Large",
      }),
    });
    await expectError(
      integration.collection(oversized),
      413,
      "request_too_large",
    );
    await createOwned(integration);
    await expectError(
      create(integration, { body: "Second body", name: "Second" }),
      409,
      "prompt_limit_reached",
    );
    database.$client.close();
  });

  test("rejects invalid input and non-JSON requests", async () => {
    const { database, integration } = createSetup();
    for (const body of [
      { body: "", name: "Name" },
      { body: "   \n", name: "Name" },
      { body: "Body", name: "" },
      { body: "é".repeat(PROMPT_BODY_MAXIMUM_BYTES / 2 + 1), name: "Large" },
      { body: "Body" },
    ]) {
      expect((await create(integration, body)).status).toBe(400);
    }
    const wrongMedia = request(PROMPTS_PATH, "POST", {
      body: "Body",
      name: "Name",
    });
    wrongMedia.headers.set("content-type", "text/plain");
    await expectError(
      integration.collection(wrongMedia),
      400,
      "invalid_request",
    );
    database.$client.close();
  });

  test("enforces normalized uniqueness and owner isolation", async () => {
    const { database, integration } = createSetup();
    await create(integration, {
      body: "Same body",
      name: "Ｒｅｌｅａｓｅ\t checklist",
    });
    expect(
      (
        await create(integration, {
          body: "Same body",
          name: "Another title",
        })
      ).status,
    ).toBe(201);
    await expectError(
      create(integration, {
        body: "Different body",
        name: "release   CHECKLIST",
      }),
      409,
      "duplicate_name",
    );

    const privateResponses = await Promise.all([
      Promise.resolve(
        integration.item(request(promptPath(OTHER_PROMPT_ID)), OTHER_PROMPT_ID),
      ),
      integration.item(
        request(
          promptPath(OTHER_PROMPT_ID),
          "PUT",
          { body: "Stolen", name: "Stolen" },
          '"1"',
        ),
        OTHER_PROMPT_ID,
      ),
      Promise.resolve(
        integration.item(
          request(promptPath(OTHER_PROMPT_ID), "DELETE", undefined, '"1"'),
          OTHER_PROMPT_ID,
        ),
      ),
    ]);
    expect(privateResponses.map(({ status }) => status)).toEqual([
      404, 404, 404,
    ]);
    expect(
      database
        .select({ body: prompts.body })
        .from(prompts)
        .where(eq(prompts.id, OTHER_PROMPT_ID))
        .get()?.body,
    ).toBe("Secret prompt body");
    database.$client.close();
  });
});
