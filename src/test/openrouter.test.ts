import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import { createDatabase, type AppDatabase } from "../database.ts";
import { openRouterCredentials, sessions, users } from "../database/schema.ts";
import { SYSTEM_ID } from "../ids.ts";
import {
  createOpenRouterIntegrationFromEnvironment,
  type OpenRouterIntegration,
} from "../openrouter.ts";
import {
  expectPkceParameters,
  expectRedirect,
  takeValue,
} from "./oauth-test-helpers.ts";

const NOW = 1_700_000_000_000;
const USER_ID = "018bcfe5-6800-7000-8000-000000000021";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000022";
const OAUTH_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000023";
const FIRST_KEY_ID = "018bcfe5-6800-7000-8000-000000000024";
const SECOND_KEY_ID = "018bcfe5-6800-7000-8000-000000000025";
const SESSION_TOKEN = "authenticated-session";
const STATE = "openrouter-state";
const VERIFIER = "openrouter-verifier";
const OAUTH_KEY = "sk-or-v1-oauth-secret";
const FIRST_KEY = "sk-or-v1-first-manual-secret";
const SECOND_KEY = "sk-or-v1-second-manual-secret";
const CALLBACK_URL = "http://localhost:3000/api/openrouter/oauth/callback";
const ENVIRONMENT = {
  OPENROUTER_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
  OPENROUTER_REDIRECT_URI: CALLBACK_URL,
};
const OAUTH_CREDENTIAL = {
  accountId: "openrouter-account-oauth",
  id: OAUTH_CREDENTIAL_ID,
  label: "OpenRouter account",
  source: "oauth",
};
const FIRST_MANUAL_CREDENTIAL = {
  accountId: "openrouter-account-first",
  id: FIRST_KEY_ID,
  label: "First manual key",
  source: "api_key",
};
const SECOND_MANUAL_CREDENTIAL = {
  accountId: "openrouter-account-second",
  id: SECOND_KEY_ID,
  label: "Second manual key",
  source: "api_key",
};

interface KeyDetails {
  readonly accountId: string;
  readonly label: string;
}

function readStoredCredentials(database: AppDatabase) {
  return database.select().from(openRouterCredentials).all();
}

function seedAuthenticatedUser(database: AppDatabase): void {
  const timestamp = new Date(NOW);

  database
    .insert(users)
    .values({
      createdAt: timestamp,
      createdById: SYSTEM_ID,
      email: "mushroom@example.com",
      googleSubject: "google-user",
      id: USER_ID,
      isDeleted: false,
      name: "Mush Room",
      updatedAt: timestamp,
      updatedById: SYSTEM_ID,
    })
    .run();
  database
    .insert(sessions)
    .values({
      createdAt: timestamp,
      createdById: USER_ID,
      expiresAt: new Date(NOW + 60_000),
      id: SESSION_ID,
      isDeleted: false,
      token: SESSION_TOKEN,
      updatedAt: timestamp,
      updatedById: USER_ID,
      userId: USER_ID,
    })
    .run();
}

function createRequest(
  path: string,
  body?: Readonly<Record<string, string>>,
  method = "GET",
): Request {
  const headers = new Headers({ cookie: `q_mush_session=${SESSION_TOKEN}` });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const init: RequestInit =
    body === undefined
      ? { headers, method }
      : { body: JSON.stringify(body), headers, method };

  return new Request(`http://localhost:3000${path}`, init);
}

function flowCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function addFlowCookies(request: Request, response: Response): void {
  const sessionCookie = request.headers.get("cookie");

  if (sessionCookie === null) {
    throw new Error("The authenticated request has no session cookie");
  }

  request.headers.set("cookie", `${sessionCookie}; ${flowCookies(response)}`);
}

function createProviderFetch(
  detailsByKey: Readonly<Record<string, KeyDetails>>,
  requests: Request[],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const request = new Request(input, init);
    requests.push(request);

    if (request.url === "https://openrouter.ai/api/v1/auth/keys") {
      return Promise.resolve(
        Response.json({ key: OAUTH_KEY, user_id: "openrouter-account-oauth" }),
      );
    }

    if (request.url === "https://openrouter.ai/api/v1/key") {
      const authorization = request.headers.get("authorization") ?? "";
      const key = authorization.replace(/^Bearer /u, "");
      const details = detailsByKey[key];

      return Promise.resolve(
        details === undefined
          ? Response.json({ error: "invalid key" }, { status: 401 })
          : Response.json({
              data: {
                creator_user_id: details.accountId,
                label: details.label,
              },
            }),
      );
    }

    return Promise.resolve(new Response(null, { status: 500 }));
  };
}

function createIntegration(
  database: AppDatabase,
  providerFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): OpenRouterIntegration {
  const auth = createGoogleAuthFromEnvironment(
    {},
    {
      database,
      now: () => NOW,
    },
  );
  const ids = [OAUTH_CREDENTIAL_ID, FIRST_KEY_ID, SECOND_KEY_ID];
  const tokens = [STATE, VERIFIER];

  return createOpenRouterIntegrationFromEnvironment(ENVIRONMENT, auth, {
    database,
    fetch: providerFetch,
    now: () => NOW,
    randomId: () => takeValue(ids, "The test ran out of credential IDs"),
    randomToken: () => takeValue(tokens, "The test ran out of OAuth tokens"),
  });
}

function setupIntegration(
  detailsByKey: Readonly<Record<string, KeyDetails>> = {},
): {
  readonly database: AppDatabase;
  readonly integration: OpenRouterIntegration;
  readonly providerRequests: Request[];
} {
  const database = createDatabase(":memory:");
  const providerRequests: Request[] = [];
  seedAuthenticatedUser(database);

  return {
    database,
    integration: createIntegration(
      database,
      createProviderFetch(detailsByKey, providerRequests),
    ),
    providerRequests,
  };
}

describe("OpenRouter credentials", () => {
  test("connects accounts with OAuth PKCE and stores multiple accounts or keys", async () => {
    const { database, integration, providerRequests } = setupIntegration({
      [FIRST_KEY]: {
        accountId: "openrouter-account-first",
        label: "First manual key",
      },
      [SECOND_KEY]: {
        accountId: "openrouter-account-second",
        label: "Second manual key",
      },
    });
    const beginResponse = integration.begin(
      createRequest("/api/openrouter/oauth"),
    );
    const authorizationUrl = new URL(
      beginResponse.headers.get("location") ?? "http://invalid",
    );
    const callbackUrl = new URL(
      authorizationUrl.searchParams.get("callback_url") ?? "http://invalid",
    );

    expect(beginResponse.status).toBe(302);
    expect(authorizationUrl.origin).toBe("https://openrouter.ai");
    expect(authorizationUrl.pathname).toBe("/auth");
    expectPkceParameters(
      authorizationUrl,
      createHash("sha256").update(VERIFIER).digest("base64url"),
    );
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(CALLBACK_URL);
    expect(callbackUrl.searchParams.get("state")).toBe(STATE);
    expect(flowCookies(beginResponse)).toContain(
      "q_mush_openrouter_verifier=openrouter-verifier",
    );

    const callbackRequest = createRequest(
      `/api/openrouter/oauth/callback?code=authorization-code&state=${STATE}`,
    );
    addFlowCookies(callbackRequest, beginResponse);
    const callbackResponse = await integration.complete(callbackRequest);

    expectRedirect(
      callbackResponse,
      "http://localhost:3000/app?openrouter=connected",
    );

    for (const key of [FIRST_KEY, SECOND_KEY]) {
      const response = await integration.credentials(
        createRequest("/api/openrouter/credentials", { apiKey: key }, "POST"),
      );
      expect(response.status).toBe(201);
      expect(await response.text()).not.toContain(key);
    }

    const listResponse = await integration.credentials(
      createRequest("/api/openrouter/credentials"),
    );

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      credentials: [
        OAUTH_CREDENTIAL,
        FIRST_MANUAL_CREDENTIAL,
        SECOND_MANUAL_CREDENTIAL,
      ],
    });

    const storedCredentials = readStoredCredentials(database);
    expect(storedCredentials).toHaveLength(3);
    expect(
      storedCredentials.every(
        ({ encryptedApiKey }) =>
          ![OAUTH_KEY, FIRST_KEY, SECOND_KEY].some((key) =>
            encryptedApiKey.includes(key),
          ),
      ),
    ).toBeTrue();
    expect(providerRequests[0]?.method).toBe("POST");
    expect(await providerRequests[0]?.json()).toEqual({
      code: "authorization-code",
      code_challenge_method: "S256",
      code_verifier: VERIFIER,
    });

    const removeResponse = integration.remove(
      createRequest(
        `/api/openrouter/credentials/${FIRST_KEY_ID}`,
        undefined,
        "DELETE",
      ),
      FIRST_KEY_ID,
    );
    expect(removeResponse.status).toBe(204);
    const removedCredential = readStoredCredentials(database).find(
      ({ id }) => id === FIRST_KEY_ID,
    );
    expect(removedCredential?.isDeleted).toBeTrue();
    expect(removedCredential?.encryptedApiKey).toBe("");
    expect(
      await integration
        .credentials(createRequest("/api/openrouter/credentials"))
        .then((response) => response.json()),
    ).toEqual({
      credentials: [OAUTH_CREDENTIAL, SECOND_MANUAL_CREDENTIAL],
    });

    database.$client.close();
  });

  test("does not exchange a callback whose state cannot be verified", async () => {
    const { database, integration, providerRequests } = setupIntegration();
    const beginResponse = integration.begin(
      createRequest("/api/openrouter/oauth"),
    );
    const callbackRequest = createRequest(
      "/api/openrouter/oauth/callback?code=authorization-code&state=wrong",
    );
    addFlowCookies(callbackRequest, beginResponse);
    const response = await integration.complete(callbackRequest);

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/app?openrouter=invalid_state",
    );
    expect(providerRequests).toEqual([]);
    expect(readStoredCredentials(database)).toEqual([]);
    database.$client.close();
  });

  test("requires login and rejects invalid manually supplied keys", async () => {
    const { database, integration } = setupIntegration();
    const anonymousRequest = new Request(
      "http://localhost:3000/api/openrouter/credentials",
    );

    expect((await integration.credentials(anonymousRequest)).status).toBe(401);
    expect(
      integration.begin(
        new Request("http://localhost:3000/api/openrouter/oauth"),
      ).status,
    ).toBe(401);

    const invalidKeyResponse = await integration.credentials(
      createRequest(
        "/api/openrouter/credentials",
        { apiKey: "invalid-key" },
        "POST",
      ),
    );

    expect(invalidKeyResponse.status).toBe(400);
    expect(await invalidKeyResponse.json()).toEqual({
      error: "invalid_api_key",
    });
    expect(readStoredCredentials(database)).toHaveLength(0);
    database.$client.close();
  });

  test("rejects incomplete or invalid credential encryption configuration", () => {
    const auth = createGoogleAuthFromEnvironment({});

    expect(() =>
      createOpenRouterIntegrationFromEnvironment(
        { OPENROUTER_REDIRECT_URI: CALLBACK_URL },
        auth,
      ),
    ).toThrow("OPENROUTER_CREDENTIAL_KEY");
    expect(() =>
      createOpenRouterIntegrationFromEnvironment(
        { OPENROUTER_CREDENTIAL_KEY: "not-a-32-byte-key" },
        auth,
      ),
    ).toThrow("32-byte base64url");
  });
});
