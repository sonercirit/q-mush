import { eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { providerCredentials } from "../../shared/database/schema.ts";
import { BRAVE_SEARCH_KEYS_PATH } from "../../shared/routes.ts";
import { createBraveSearchSkillFromEnvironment } from "../../sync-engine/brave-search.ts";
import type { OAuthDependencies } from "../../sync-engine/oauth.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const FIRST_KEY_ID = "018bcfe5-6800-7000-8000-000000000081";
const SECOND_KEY_ID = "018bcfe5-6800-7000-8000-000000000082";
const FIRST_KEY = "BSA-first-secret";
const SECOND_KEY = "BSA-second-secret";
const ENVIRONMENT = {
  BRAVE_SEARCH_CREDENTIAL_KEY: Buffer.alloc(32, 11).toString("base64url"),
};

function createSetup() {
  const { auth, database } = createAuthenticatedTestContext();
  const requests: Request[] = [];
  const fetch: NonNullable<OAuthDependencies["fetch"]> = (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const apiKey = request.headers.get("x-subscription-token");

    if (apiKey === FIRST_KEY) {
      return Promise.resolve(
        Response.json({ message: "rate limited" }, { status: 429 }),
      );
    }

    if (apiKey === SECOND_KEY) {
      return Promise.resolve(
        Response.json({
          web: {
            results: [
              {
                title: "Bun",
                url: "https://bun.sh/",
                age: "2 days ago",
                description: "A fast all-in-one JavaScript runtime.",
              },
            ],
          },
        }),
      );
    }

    return Promise.resolve(
      Response.json({ message: "invalid key" }, { status: 401 }),
    );
  };
  const ids = [FIRST_KEY_ID, SECOND_KEY_ID];
  const skill = createBraveSearchSkillFromEnvironment(ENVIRONMENT, auth, {
    database,
    fetch,
    now: () => TEST_NOW,
    randomId: () => takeValue(ids, "The test ran out of Brave key IDs"),
  });
  return { database, requests, skill };
}

describe("Brave Search skill", () => {
  test("stores multiple keys and uses the next key when one is rate limited", async () => {
    const setup = createSetup();

    for (const key of [
      { apiKey: FIRST_KEY, label: "Primary" },
      { apiKey: SECOND_KEY, label: "Backup" },
    ]) {
      const request = createAuthenticatedRequest(
        BRAVE_SEARCH_KEYS_PATH,
        key,
        "POST",
      );
      const response = await setup.skill.keys(request);
      expect(response.status).toBe(201);
      const body = await response.text();
      expect(body.includes(key.apiKey)).toBe(false);
    }

    const listResponse = await setup.skill.keys(
      createAuthenticatedRequest(BRAVE_SEARCH_KEYS_PATH),
    );
    expect(await listResponse.json()).toEqual({
      credentials: [
        {
          accountId: null,
          id: FIRST_KEY_ID,
          isDefault: false,
          isGlobal: true,
          label: "Primary",
          source: "api_key",
          workspaceIds: [],
        },
        {
          accountId: null,
          id: SECOND_KEY_ID,
          isDefault: false,
          isGlobal: true,
          label: "Backup",
          source: "api_key",
          workspaceIds: [],
        },
      ],
    });

    const stored = setup.database.select().from(providerCredentials).all();
    const encryptedCredentials = stored.map(
      ({ encryptedCredential }) => encryptedCredential,
    );
    expect(encryptedCredentials).not.toContain(FIRST_KEY);
    expect(encryptedCredentials).not.toContain(SECOND_KEY);

    const output = await setup.skill.execute(TEST_USER_ID, TEST_WORKSPACE_ID, {
      count: 2,
      query: "bun typescript",
    });
    expect(JSON.parse(output)).toEqual({
      query: "bun typescript",
      results: [
        {
          age: "2 days ago",
          description: "A fast all-in-one JavaScript runtime.",
          title: "Bun",
          url: "https://bun.sh/",
        },
      ],
    });
    expect(setup.requests).toHaveLength(2);
    expect(
      setup.requests.map((request) =>
        request.headers.get("x-subscription-token"),
      ),
    ).toEqual([FIRST_KEY, SECOND_KEY]);
    expect(new URL(setup.requests[1]?.url ?? "http://invalid").search).toBe(
      "?q=bun+typescript&count=2",
    );

    const removeResponse = setup.skill.remove(
      createAuthenticatedRequest(
        `${BRAVE_SEARCH_KEYS_PATH}/${FIRST_KEY_ID}`,
        undefined,
        "DELETE",
      ),
      FIRST_KEY_ID,
    );
    expect(removeResponse.status).toBe(204);
    const removedCredentials = setup.database
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, FIRST_KEY_ID))
      .all();
    expect(removedCredentials).toMatchObject([
      { encryptedCredential: "", isDeleted: true },
    ]);
    setup.database.$client.close();
  });

  test("aborts an in-flight provider request without falling through keys", async () => {
    const { auth, database } = createAuthenticatedTestContext();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const skill = createBraveSearchSkillFromEnvironment(ENVIRONMENT, auth, {
      database,
      fetch: (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("stopped", "AbortError"));
            },
            { once: true },
          );
        });
      },
      now: () => TEST_NOW,
      randomId: () => FIRST_KEY_ID,
    });
    const keyResponse = await skill.keys(
      createAuthenticatedRequest(
        BRAVE_SEARCH_KEYS_PATH,
        { apiKey: FIRST_KEY, label: "Primary" },
        "POST",
      ),
    );
    expect(keyResponse.status).toBe(201);

    const running = skill.execute(
      TEST_USER_ID,
      TEST_WORKSPACE_ID,
      { query: "cancel me" },
      controller.signal,
    );
    await Promise.resolve();
    expect(requestSignal).toBe(controller.signal);
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    database.$client.close();
  });

  test("requires login and reports unconfigured encrypted storage", async () => {
    expect(() => {
      const context = createAuthenticatedTestContext();
      try {
        createBraveSearchSkillFromEnvironment(
          { BRAVE_SEARCH_CREDENTIAL_KEY: "not-a-32-byte-key" },
          context.auth,
        );
      } finally {
        context.database.$client.close();
      }
    }).toThrow("BRAVE_SEARCH_CREDENTIAL_KEY must be a 32-byte base64url value");

    const configured = createSetup();
    expect(
      (
        await configured.skill.keys(
          new Request(`http://localhost${BRAVE_SEARCH_KEYS_PATH}`),
        )
      ).status,
    ).toBe(401);
    configured.database.$client.close();

    const { auth, database } = createAuthenticatedTestContext();
    const unconfigured = createBraveSearchSkillFromEnvironment({}, auth, {
      database,
    });
    expect(
      (
        await unconfigured.keys(
          createAuthenticatedRequest(BRAVE_SEARCH_KEYS_PATH),
        )
      ).status,
    ).toBe(503);
    expect(
      await unconfigured.execute(TEST_USER_ID, TEST_WORKSPACE_ID, {
        query: "test",
      }),
    ).toBe("Error: Brave Search credential storage is not configured.");
    database.$client.close();
  });
});
