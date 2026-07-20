import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import { createCredentialCipher } from "../credential-cipher.ts";
import {
  createOpenAiIntegrationFromEnvironment,
  createOpenAiLoopbackCallbackHandler,
} from "../openai.ts";
import { ProviderCredentialStore } from "../provider-credential-store.ts";
import {
  createAuthenticatedRequest,
  readFlowCookies,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { expectPkceParameters, expectRedirect } from "./oauth-test-helpers.ts";
import * as providerTest from "./provider-integration-test-helpers.ts";

const FIRST_OAUTH_ID = "018bcfe5-6800-7000-8000-000000000031";
const SECOND_OAUTH_ID = "018bcfe5-6800-7000-8000-000000000032";
const FIRST_KEY_ID = "018bcfe5-6800-7000-8000-000000000033";
const SECOND_KEY_ID = "018bcfe5-6800-7000-8000-000000000034";
const FIRST_STATE = "openai-state-one";
const FIRST_VERIFIER = "openai-verifier-one";
const SECOND_STATE = "openai-state-two";
const SECOND_VERIFIER = "openai-verifier-two";
const FIRST_MANUAL_KEY = "sk-proj-openai-manual-one";
const SECOND_MANUAL_KEY = "sk-proj-openai-manual-two";
const CALLBACK_URL = "http://localhost:3000/api/openai/oauth/callback";
const CLIENT_ID = "q-mush-openai-client";
const ENVIRONMENT = {
  OPENAI_CLIENT_ID: CLIENT_ID,
  OPENAI_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64url"),
  OPENAI_REDIRECT_URI: CALLBACK_URL,
};
const FIRST_OAUTH_CREDENTIAL = {
  accountId: "chatgpt-workspace-one",
  id: FIRST_OAUTH_ID,
  label: "one@example.com",
  source: "oauth",
};
const SECOND_OAUTH_CREDENTIAL = {
  accountId: "chatgpt-workspace-two",
  id: SECOND_OAUTH_ID,
  label: "two@example.com",
  source: "oauth",
};
const FIRST_MANUAL_CREDENTIAL = {
  accountId: "openai-user-one",
  id: FIRST_KEY_ID,
  label: "First OpenAI user",
  source: "api_key",
};
const SECOND_MANUAL_CREDENTIAL = {
  accountId: "openai-user-two",
  id: SECOND_KEY_ID,
  label: "Second OpenAI user",
  source: "api_key",
};

interface ManualKeyDetails {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

interface OAuthAccount {
  readonly accessToken: string;
  readonly accountId: string;
  readonly code: string;
  readonly email: string;
  readonly idToken: string;
  readonly refreshToken: string;
}

async function readFormBody(
  request: Request | undefined,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    new URLSearchParams(await request?.text()).entries(),
  );
}

function createIdToken(email: string, accountId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_user_id: `user-${accountId}`,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

const FIRST_ID_TOKEN = createIdToken(
  "one@example.com",
  "chatgpt-workspace-one",
);
const SECOND_ID_TOKEN = createIdToken(
  "two@example.com",
  "chatgpt-workspace-two",
);
const OAUTH_ACCOUNTS: readonly OAuthAccount[] = [
  {
    accessToken: "oauth-access-token-one",
    accountId: "chatgpt-workspace-one",
    code: "authorization-code-one",
    email: "one@example.com",
    idToken: FIRST_ID_TOKEN,
    refreshToken: "oauth-refresh-token-one",
  },
  {
    accessToken: "oauth-access-token-two",
    accountId: "chatgpt-workspace-two",
    code: "authorization-code-two",
    email: "two@example.com",
    idToken: SECOND_ID_TOKEN,
    refreshToken: "oauth-refresh-token-two",
  },
];

const createProviderFetch = (
  detailsByKey: Readonly<Record<string, ManualKeyDetails>>,
  requests: Request[],
): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  async function openAiProviderFetch(input, init) {
    const request = providerTest.recordProviderRequest(
      requests,
      input,
      init,
      true,
    );

    if (request.url === "https://auth.openai.com/oauth/token") {
      const body = new URLSearchParams(await request.text());

      if (body.get("grant_type") === "authorization_code") {
        const account = OAUTH_ACCOUNTS.find(
          ({ code }) => code === body.get("code"),
        );
        return account === undefined
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({
              access_token: account.accessToken,
              id_token: account.idToken,
              expires_in: 3600,
              refresh_token: account.refreshToken,
            });
      }

      if (
        body.get("grant_type") === "refresh_token" &&
        body.get("refresh_token") === "oauth-refresh-token-one"
      ) {
        return Response.json({
          access_token: "refreshed-access-token",
          expires_in: 7200,
          refresh_token: "refreshed-refresh-token",
        });
      }

      return Response.json(
        { error: "unsupported_grant_type" },
        { status: 400 },
      );
    }

    if (request.url === "https://api.openai.com/v1/me") {
      const details = detailsByKey[providerTest.readBearerApiKey(request)];

      if (details === undefined) {
        return Response.json({ error: "invalid key" }, { status: 401 });
      }

      return Response.json({ object: "user", ...details });
    }

    return new Response(null, { status: 500 });
  };

const TEST_ROUTES = providerTest.defineProviderTestRoutes("openai");
const INTEGRATION_TEST_CONFIGURATION =
  providerTest.defineProviderTestConfiguration(
    createProviderFetch,
    ENVIRONMENT,
    createOpenAiIntegrationFromEnvironment,
    [FIRST_OAUTH_ID, SECOND_OAUTH_ID, FIRST_KEY_ID, SECOND_KEY_ID],
    "openai",
    [FIRST_STATE, FIRST_VERIFIER, SECOND_STATE, SECOND_VERIFIER],
  );
const setupIntegration = providerTest.createProviderTestSetup(
  INTEGRATION_TEST_CONFIGURATION,
);
const connectAccount = providerTest.createProviderAccountConnector(TEST_ROUTES);

describe("OpenAI credentials", () => {
  test("connects multiple accounts with OAuth PKCE and stores multiple API keys", async () => {
    const { database, integration, providerRequests } = setupIntegration({
      [FIRST_MANUAL_KEY]: {
        email: "manual-one@example.com",
        id: "openai-user-one",
        name: "First OpenAI user",
      },
      [SECOND_MANUAL_KEY]: {
        email: "manual-two@example.com",
        id: "openai-user-two",
        name: "Second OpenAI user",
      },
    });
    const firstConnection = await connectAccount(
      integration,
      FIRST_STATE,
      "authorization-code-one",
    );

    expect(firstConnection.response.status).toBe(302);
    expect(firstConnection.authorizationUrl.origin).toBe(
      "https://auth.openai.com",
    );
    expect(firstConnection.authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(firstConnection.authorizationUrl.searchParams.get("client_id")).toBe(
      CLIENT_ID,
    );
    expect(
      firstConnection.authorizationUrl.searchParams.get("redirect_uri"),
    ).toBe(CALLBACK_URL);
    expect(firstConnection.authorizationUrl.searchParams.get("scope")).toBe(
      "openid profile email offline_access",
    );
    expect(firstConnection.authorizationUrl.searchParams.get("state")).toBe(
      FIRST_STATE,
    );
    expect(
      firstConnection.authorizationUrl.searchParams.get("originator"),
    ).toBe("q_mush");
    expectPkceParameters(
      firstConnection.authorizationUrl,
      crypto.createHash("sha256").update(FIRST_VERIFIER).digest("base64url"),
    );
    expectRedirect(
      firstConnection.response,
      "http://localhost:3000/app?openai=connected",
    );

    const secondConnection = await connectAccount(
      integration,
      SECOND_STATE,
      "authorization-code-two",
    );
    expectRedirect(
      secondConnection.response,
      "http://localhost:3000/app?openai=connected",
    );

    await providerTest.addProviderApiKeys(
      integration,
      TEST_ROUTES.credentialsPath,
      [FIRST_MANUAL_KEY, SECOND_MANUAL_KEY],
    );

    const listResponse = await integration.credentials(
      createAuthenticatedRequest(TEST_ROUTES.credentialsPath),
    );
    expect(await listResponse.json()).toEqual(
      providerTest.credentialSummaries([
        FIRST_OAUTH_CREDENTIAL,
        SECOND_OAUTH_CREDENTIAL,
        FIRST_MANUAL_CREDENTIAL,
        SECOND_MANUAL_CREDENTIAL,
      ]),
    );

    const storedCredentials = providerTest.readStoredProviderCredentials(
      database,
      "openai",
    );
    expect(storedCredentials).toHaveLength(4);
    const secrets = [
      ...OAUTH_ACCOUNTS.flatMap(({ accessToken, idToken, refreshToken }) => [
        accessToken,
        idToken,
        refreshToken,
      ]),
      FIRST_MANUAL_KEY,
      SECOND_MANUAL_KEY,
    ];
    expect(
      storedCredentials.every(({ encryptedCredential }) =>
        secrets.every((secret) => !encryptedCredential.includes(secret)),
      ),
    ).toBeTrue();

    expect(providerRequests[0]?.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(await readFormBody(providerRequests[0])).toEqual({
      client_id: CLIENT_ID,
      code: "authorization-code-one",
      code_verifier: FIRST_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK_URL,
    });
    expect(providerRequests).toHaveLength(4);
    const credentialStore = new ProviderCredentialStore(
      database,
      createCredentialCipher(ENVIRONMENT.OPENAI_CREDENTIAL_KEY),
      "openai",
    );
    expect(
      JSON.parse(
        credentialStore.readSecret(TEST_USER_ID, FIRST_OAUTH_ID) ?? "null",
      ),
    ).toEqual({
      access: "oauth-access-token-one",
      expires: TEST_NOW + 3_600_000,
      refresh: "oauth-refresh-token-one",
    });

    credentialStore.updateSecret(
      TEST_USER_ID,
      FIRST_OAUTH_ID,
      JSON.stringify({
        access: "expired-access-token",
        expires: TEST_NOW,
        refresh: "oauth-refresh-token-one",
      }),
      TEST_NOW,
    );
    const refreshed = await integration.readCredential(
      TEST_USER_ID,
      FIRST_OAUTH_ID,
    );
    expect(JSON.parse(refreshed?.secret ?? "null")).toEqual({
      access: "refreshed-access-token",
      expires: TEST_NOW + 7_200_000,
      refresh: "refreshed-refresh-token",
    });
    expect(await readFormBody(providerRequests.at(-1))).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "oauth-refresh-token-one",
    });

    providerTest.expectRemovedProviderCredential(
      { database, integration, providerRequests },
      TEST_ROUTES,
      FIRST_KEY_ID,
    );
    database.$client.close();
  });

  test("rejects an OAuth callback with unverifiable state", () =>
    providerTest.expectInvalidProviderState(
      setupIntegration(),
      TEST_ROUTES,
      "authorization-code-one",
    ));

  test("protects access and rejects an invalid API key", () =>
    providerTest.expectProtectedInvalidApiKey(setupIntegration(), TEST_ROUTES));

  test("uses the registered Codex loopback callback by default", async () => {
    const setupLoopbackIntegration = providerTest.createProviderTestSetup(
      providerTest.defineProviderTestConfiguration(
        createProviderFetch,
        { OPENAI_CREDENTIAL_KEY: ENVIRONMENT.OPENAI_CREDENTIAL_KEY },
        createOpenAiIntegrationFromEnvironment,
        [FIRST_OAUTH_ID],
        "openai",
        [FIRST_STATE, FIRST_VERIFIER],
      ),
    );
    const { database, integration } = setupLoopbackIntegration();
    const { authorizationUrl, callbackRequest } =
      providerTest.beginProviderAccount({
        callbackPath: "/auth/callback",
        code: "authorization-code-one",
        integration,
        oauthPath: TEST_ROUTES.oauthPath,
        state: FIRST_STATE,
      });
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );

    const handleCallback = createOpenAiLoopbackCallbackHandler(
      integration,
      "http://localhost:3000",
    );
    const response = await handleCallback(callbackRequest);
    expectRedirect(response, "http://localhost:3000/app?openai=connected");
    database.$client.close();
  });

  test("rejects incomplete or invalid OpenAI configuration", () => {
    const auth = createGoogleAuthFromEnvironment({});

    expect(() =>
      createOpenAiIntegrationFromEnvironment(
        { OPENAI_REDIRECT_URI: CALLBACK_URL },
        auth,
      ),
    ).toThrow("OPENAI_CREDENTIAL_KEY");
    expect(() =>
      createOpenAiIntegrationFromEnvironment(
        { OPENAI_CREDENTIAL_KEY: "not-a-32-byte-key" },
        auth,
      ),
    ).toThrow("32-byte base64url");
    expect(() =>
      createOpenAiIntegrationFromEnvironment(
        {
          OPENAI_CLIENT_ID: " ",
          OPENAI_CREDENTIAL_KEY: ENVIRONMENT.OPENAI_CREDENTIAL_KEY,
        },
        auth,
      ),
    ).toThrow("OPENAI_CLIENT_ID");
  });

  test("marks the OAuth cookies HttpOnly and clears them after completion", async () => {
    const { database, integration } = setupIntegration();
    const { beginResponse, response } = await connectAccount(
      integration,
      FIRST_STATE,
      "authorization-code-one",
    );

    expect(readFlowCookies(beginResponse)).toContain(
      "q_mush_openai_verifier=openai-verifier-one",
    );
    expect(
      beginResponse.headers
        .getSetCookie()
        .every((cookie) => cookie.includes("HttpOnly")),
    ).toBeTrue();

    expect(
      response.headers
        .getSetCookie()
        .every((cookie) => cookie.includes("Max-Age=0")),
    ).toBeTrue();
    database.$client.close();
  });
});
