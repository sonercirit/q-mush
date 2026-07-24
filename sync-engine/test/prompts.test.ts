import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { prompts } from "../../shared/database/schema.ts";
import {
  PROMPT_BODY_MAXIMUM_LENGTH,
  PROMPT_NAME_MAXIMUM_LENGTH,
} from "../../shared/prompt-model.ts";
import { promptPath, PROMPTS_PATH } from "../../shared/routes.ts";
import {
  createPromptIntegration,
  type PromptIntegration,
} from "../../sync-engine/prompts.ts";
import {
  addOtherTestUser,
  createAuthenticatedIntegration,
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  OTHER_TEST_USER_ID,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";

const PROMPT_ID = "018bcfe5-6800-7000-8000-000000000071";
const OTHER_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000072";
const NEXT_PROMPT_ID = "018bcfe5-6800-7000-8000-000000000073";
const REVISION = '"1"';

interface SetupOptions {
  readonly maximumCount?: number;
}

function createSetup(options: SetupOptions = {}) {
  const database = createAuthenticatedTestDatabase();
  addOtherTestUser(database);
  database
    .insert(prompts)
    .values({
      ...createdAuditFields(OTHER_TEST_USER_ID, TEST_NOW),
      body: "Secret prompt body",
      id: OTHER_PROMPT_ID,
      name: "Private prompt",
      normalizedName: "private prompt",
      userId: OTHER_TEST_USER_ID,
    })
    .run();
  let nextId = 0;
  const ids = [PROMPT_ID, NEXT_PROMPT_ID];
  const integration = createAuthenticatedIntegration(database, (auth) =>
    createPromptIntegration(auth, {
      database,
      ...(options.maximumCount === undefined
        ? {}
        : { maximumCount: options.maximumCount }),
      now: () => TEST_NOW,
      randomId: () => ids[nextId++] ?? `prompt-${String(nextId)}`,
    }),
  );
  return { database, integration };
}

interface PromptRequestOptions {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly contentType?: string;
  readonly method?: string;
  readonly path: string;
  readonly revision?: string;
}

function promptRequest(options: PromptRequestOptions): Request {
  const request = createAuthenticatedRequest(
    options.path,
    options.body,
    options.method,
  );
  if (options.contentType !== undefined) {
    request.headers.set("content-type", options.contentType);
  }
  if (options.revision !== undefined) {
    request.headers.set("if-match", options.revision);
  }
  return request;
}

function itemRequest(
  integration: PromptIntegration,
  method = "GET",
  body?: Readonly<Record<string, unknown>>,
  revision?: string,
): Promise<Response> | Response {
  return integration.item(
    promptRequest({
      ...(body === undefined ? {} : { body }),
      method,
      path: promptPath(PROMPT_ID),
      ...(revision === undefined ? {} : { revision }),
    }),
    PROMPT_ID,
  );
}

function createRequest(
  integration: PromptIntegration,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> | Response {
  return integration.collection(
    promptRequest({ body, method: "POST", path: PROMPTS_PATH }),
  );
}

async function responseJson(response: Response): Promise<unknown> {
  return await response.json();
}

async function expectApiError(
  response: Promise<Response> | Response,
  status: number,
  error: string,
): Promise<void> {
  const resolved = await response;
  expect([resolved.status, await responseJson(resolved)]).toEqual([
    status,
    { error },
  ]);
}

async function createOwnedPrompt(
  integration: PromptIntegration,
): Promise<void> {
  const response = await createRequest(integration, {
    body: "Original body",
    name: "Original name",
  });
  expect(response.status).toBe(201);
}

describe("prompt API", () => {
  test("requires authentication and supported methods", async () => {
    const { database, integration } = createSetup();
    const unauthenticated = await Promise.all([
      Promise.resolve(
        integration.collection(new Request(`http://localhost${PROMPTS_PATH}`)),
      ),
      Promise.resolve(
        integration.collection(
          new Request(`http://localhost${PROMPTS_PATH}`, { method: "POST" }),
        ),
      ),
      Promise.resolve(
        integration.item(
          new Request(`http://localhost${promptPath(PROMPT_ID)}`),
          PROMPT_ID,
        ),
      ),
    ]);

    expect(unauthenticated.map(({ status }) => status)).toEqual([
      401, 401, 401,
    ]);
    const collectionMethod = await integration.collection(
      promptRequest({ method: "PUT", path: PROMPTS_PATH }),
    );
    const itemMethod = await integration.item(
      promptRequest({ method: "POST", path: promptPath(PROMPT_ID) }),
      PROMPT_ID,
    );
    expect([collectionMethod.status, itemMethod.status]).toEqual([405, 405]);
    database.$client.close();
  });

  test("preserves bodies, normalizes titles, and versions writes", async () => {
    const { database, integration } = createSetup();
    const body = "  Inspect the repository.\nKeep this spacing.  ";
    const createdResponse = await createRequest(integration, {
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
    expect([
      createdResponse.status,
      await responseJson(createdResponse),
    ]).toEqual([201, created]);

    const listed = await integration.collection(
      promptRequest({ path: PROMPTS_PATH }),
    );
    const fetched = await itemRequest(integration);
    expect([await responseJson(listed), await responseJson(fetched)]).toEqual([
      { prompts: [created] },
      created,
    ]);

    const updatedResponse = await itemRequest(
      integration,
      "PUT",
      { body: "\nUpdated without trimming\n", name: "Test" },
      REVISION,
    );
    expect(await responseJson(updatedResponse)).toMatchObject({
      body: "\nUpdated without trimming\n",
      name: "Test",
      revision: 2,
    });

    const removedResponse = await itemRequest(
      integration,
      "DELETE",
      undefined,
      '"2"',
    );
    expect(removedResponse.status).toBe(204);
    expect(
      database
        .select({ isDeleted: prompts.isDeleted, revision: prompts.revision })
        .from(prompts)
        .where(eq(prompts.id, PROMPT_ID))
        .get(),
    ).toEqual({ isDeleted: true, revision: 3 });
    expect((await itemRequest(integration)).status).toBe(404);
    database.$client.close();
  });

  test("requires current revisions and keeps newer writes", async () => {
    const { database, integration } = createSetup();
    await createOwnedPrompt(integration);

    await expectApiError(
      itemRequest(integration, "PUT", { body: "No revision", name: "No" }),
      428,
      "precondition_required",
    );
    await expectApiError(
      itemRequest(integration, "DELETE"),
      428,
      "precondition_required",
    );
    const current = await itemRequest(
      integration,
      "PUT",
      { body: "Current body", name: "Current" },
      REVISION,
    );
    expect(current.status).toBe(200);
    await expectApiError(
      itemRequest(
        integration,
        "PUT",
        { body: "Stale overwrite", name: "Stale" },
        REVISION,
      ),
      412,
      "prompt_changed",
    );
    await expectApiError(
      itemRequest(integration, "DELETE", undefined, REVISION),
      412,
      "prompt_changed",
    );
    expect(await responseJson(await itemRequest(integration))).toMatchObject({
      body: "Current body",
      revision: 2,
    });
    database.$client.close();
  });

  test("bounds request envelopes and per-user active prompts", async () => {
    const { database, integration } = createSetup({ maximumCount: 1 });
    const hugeBody = JSON.stringify({
      body: "x".repeat(
        (PROMPT_BODY_MAXIMUM_LENGTH + PROMPT_NAME_MAXIMUM_LENGTH) * 6 + 1_025,
      ),
      name: "Large",
    });
    const hugeRequest = createAuthenticatedRequest(
      PROMPTS_PATH,
      undefined,
      "POST",
    );
    hugeRequest.headers.set("content-type", "application/json");
    const tooLarge = integration.collection(
      new Request(hugeRequest, { body: hugeBody }),
    );
    await expectApiError(tooLarge, 413, "request_too_large");

    await createOwnedPrompt(integration);
    await expectApiError(
      createRequest(integration, {
        body: "Duplicate bodies are valid",
        name: "Second",
      }),
      409,
      "prompt_limit_reached",
    );
    database.$client.close();
  });

  test("validates media, input, normalized names, and ownership", async () => {
    const { database, integration } = createSetup();
    const invalidValues: readonly Readonly<Record<string, unknown>>[] = [
      { body: "Body", name: "" },
      { body: "   \n", name: "Name" },
      { body: "Body", name: "n".repeat(PROMPT_NAME_MAXIMUM_LENGTH + 1) },
      { body: "b".repeat(PROMPT_BODY_MAXIMUM_LENGTH + 1), name: "Name" },
      { body: "Body" },
      { name: "Name" },
    ];
    for (const value of invalidValues) {
      const response = await createRequest(integration, value);
      expect(response.status).toBe(400);
    }
    await expectApiError(
      integration.collection(
        promptRequest({
          body: { body: "Body", name: "Wrong media" },
          contentType: "text/plain",
          method: "POST",
          path: PROMPTS_PATH,
        }),
      ),
      400,
      "invalid_request",
    );

    await createRequest(integration, {
      body: "Same body",
      name: "Ｒｅｌｅａｓｅ\t checklist",
    });
    const duplicateBody = await createRequest(integration, {
      body: "Same body",
      name: "Another title",
    });
    expect(duplicateBody.status).toBe(201);
    await expectApiError(
      createRequest(integration, {
        body: "Different body",
        name: "release   CHECKLIST",
      }),
      409,
      "duplicate_name",
    );

    const privateResponses = await Promise.all([
      Promise.resolve(
        integration.item(
          promptRequest({ path: promptPath(OTHER_PROMPT_ID) }),
          OTHER_PROMPT_ID,
        ),
      ),
      integration.item(
        promptRequest({
          body: { body: "Stolen", name: "Stolen" },
          method: "PUT",
          path: promptPath(OTHER_PROMPT_ID),
          revision: REVISION,
        }),
        OTHER_PROMPT_ID,
      ),
      Promise.resolve(
        integration.item(
          promptRequest({
            method: "DELETE",
            path: promptPath(OTHER_PROMPT_ID),
            revision: REVISION,
          }),
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
