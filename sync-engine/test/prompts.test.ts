import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { prompts } from "../../shared/database/schema.ts";
import { promptPath, PROMPTS_PATH } from "../../shared/routes.ts";
import { createPromptIntegration } from "../../sync-engine/prompts.ts";
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

function createSetup() {
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
  const integration = createAuthenticatedIntegration(database, (auth) =>
    createPromptIntegration(auth, {
      database,
      now: () => TEST_NOW,
      randomId: () => PROMPT_ID,
    }),
  );
  return { database, integration };
}

function promptRequest(options: {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly method?: string;
  readonly path: string;
}): Request {
  const request = createAuthenticatedRequest(
    options.path,
    options.body,
    options.method,
  );
  request.headers.set("x-prompt-test", "true");
  return request;
}

function itemRequest(
  integration: ReturnType<typeof createPromptIntegration>,
  method = "GET",
  body?: Readonly<Record<string, unknown>>,
): Promise<Response> | Response {
  const options = {
    ...(body === undefined ? {} : { body }),
    method,
    path: promptPath(PROMPT_ID),
  };
  return integration.item(promptRequest(options), PROMPT_ID);
}

async function responseJson(response: Response): Promise<unknown> {
  return await response.json();
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
    expect(
      (
        await integration.collection(
          promptRequest({ method: "PUT", path: PROMPTS_PATH }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await integration.item(
          promptRequest({ method: "POST", path: promptPath(PROMPT_ID) }),
          PROMPT_ID,
        )
      ).status,
    ).toBe(405);
    database.$client.close();
  });

  test("creates, lists, reads, updates, and soft deletes owned prompts", async () => {
    const { database, integration } = createSetup();
    const createdResponse = await integration.collection(
      promptRequest({
        body: { body: "  Inspect the repository.  ", name: "  Inspect  " },
        method: "POST",
        path: PROMPTS_PATH,
      }),
    );
    const created = {
      body: "Inspect the repository.",
      createdAt: TEST_NOW,
      id: PROMPT_ID,
      name: "Inspect",
      updatedAt: TEST_NOW,
    };
    expect(createdResponse.status).toBe(201);
    expect(await responseJson(createdResponse)).toEqual(created);

    const listResponse = await integration.collection(
      promptRequest({ path: PROMPTS_PATH }),
    );
    expect(await responseJson(listResponse)).toEqual({ prompts: [created] });
    expect(await responseJson(await itemRequest(integration))).toMatchObject({
      body: "Inspect the repository.",
      id: PROMPT_ID,
    });

    const updatedResponse = await itemRequest(integration, "PUT", {
      body: "Write focused tests.",
      name: "Test",
    });
    expect(updatedResponse.status).toBe(200);
    expect(await responseJson(updatedResponse)).toMatchObject({
      body: "Write focused tests.",
      id: PROMPT_ID,
      name: "Test",
    });

    const removedResponse = await itemRequest(integration, "DELETE");
    expect(removedResponse.status).toBe(204);
    expect(
      database
        .select({ isDeleted: prompts.isDeleted })
        .from(prompts)
        .where(eq(prompts.id, PROMPT_ID))
        .get()?.isDeleted,
    ).toBe(true);
    expect((await itemRequest(integration)).status).toBe(404);
    database.$client.close();
  });

  test("validates input, reports duplicate names, and hides other users", async () => {
    const { database, integration } = createSetup();
    const invalidValues: readonly Readonly<Record<string, unknown>>[] = [
      { body: "Body", name: "" },
      { body: "", name: "Name" },
      { body: "Body", name: "n".repeat(101) },
      { body: "b".repeat(32_769), name: "Name" },
      { body: "Body" },
      { name: "Name" },
    ];

    for (const value of invalidValues) {
      const response = await integration.collection(
        promptRequest({ body: value, method: "POST", path: PROMPTS_PATH }),
      );
      expect(response.status).toBe(400);
    }

    await integration.collection(
      promptRequest({
        body: { body: "First", name: "Release checklist" },
        method: "POST",
        path: PROMPTS_PATH,
      }),
    );
    const duplicate = await integration.collection(
      promptRequest({
        body: { body: "Second", name: "RELEASE CHECKLIST" },
        method: "POST",
        path: PROMPTS_PATH,
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await responseJson(duplicate)).toEqual({ error: "duplicate_name" });

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
        }),
        OTHER_PROMPT_ID,
      ),
      Promise.resolve(
        integration.item(
          promptRequest({
            method: "DELETE",
            path: promptPath(OTHER_PROMPT_ID),
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
