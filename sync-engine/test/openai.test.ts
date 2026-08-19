import { eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import { providerCredentials } from "../../shared/database/schema.ts";
import { ProviderCredentialStore } from "../../shared/provider-credential-store.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import {
  createOpenAiIntegrationFromEnvironment,
  createOpenAiLoopbackCallbackHandler,
} from "../../sync-engine/openai.ts";
import {
  createAuthenticatedRequest,
  readFlowCookies,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { oauthTokenResponse } from "./oauth-test-fixtures.ts";
import { expectPkceParameters, expectRedirect } from "./oauth-test-helpers.ts";
import {
  addProviderApiKeys,
  beginProviderAccount,
  createProviderAccountConnector,
  createProviderTestSetup,
  credentialSummaries,
  defineProviderTestConfiguration,
  defineProviderTestRoutes,
  expectInvalidProviderState,
  expectProtectedInvalidApiKey,
  expectRemovedProviderCredential,
  readBearerApiKey,
  readStoredProviderCredentials,
  recordOpenAiProviderRequest,
} from "./provider-integration-test-helpers.ts";

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
  isDefault: false,
  label: "one@example.com",
  source: "oauth",
};
const SECOND_OAUTH_CREDENTIAL = {
  accountId: "chatgpt-workspace-two",
  id: SECOND_OAUTH_ID,
  isDefault: false,
  label: "two@example.com",
  source: "oauth",
};
const FIRST_MANUAL_CREDENTIAL = {
  accountId: "openai-user-one",
  id: FIRST_KEY_ID,
  isDefault: false,
  label: "First OpenAI user",
  source: "api_key",
};
const SECOND_MANUAL_CREDENTIAL = {
  accountId: "openai-user-two",
  id: SECOND_KEY_ID,
  isDefault: false,
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
    const { request, token } = recordOpenAiProviderRequest(
      requests,
      input,
      init,
    );

    if (token) {
      const body = new URLSearchParams(await request.text());

      if (body.get("grant_type") === "authorization_code") {
        const account = OAUTH_ACCOUNTS.find(
          ({ code }) => code === body.get("code"),
        );
        return account === undefined
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : oauthTokenResponse({
              accessToken: account.accessToken,
              idToken: account.idToken,
              refreshToken: account.refreshToken,
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
      const details = detailsByKey[readBearerApiKey(request)];

      if (details === undefined) {
        return Response.json({ error: "invalid key" }, { status: 401 });
      }

      return Response.json({ object: "user", ...details });
    }

    return new Response(null, { status: 500 });
  };

const TEST_ROUTES = defineProviderTestRoutes("openai");
const setupIntegration = createProviderTestSetup(
  defineProviderTestConfiguration(
    createProviderFetch,
    ENVIRONMENT,
    createOpenAiIntegrationFromEnvironment,
    [FIRST_OAUTH_ID, SECOND_OAUTH_ID, FIRST_KEY_ID, SECOND_KEY_ID],
    "openai",
    [
      FIRST_STATE,
      FIRST_VERIFIER,
      SECOND_STATE,
      SECOND_VERIFIER,
      "openai-state-three",
      "openai-verifier-three",
      "openai-state-four",
      "openai-verifier-four",
      "openai-state-five",
      "openai-verifier-five",
      "openai-state-six",
      "openai-verifier-six",
      "openai-state-seven",
      "openai-verifier-seven",
      "openai-state-eight",
      "openai-verifier-eight",
    ],
  ),
);
const connectAccount = createProviderAccountConnector(TEST_ROUTES);

function beginReconnect(
  integration: ReturnType<typeof setupIntegration>["integration"],
  state: string,
  code = "authorization-code-one",
) {
  return beginProviderAccount({
    callbackPath: TEST_ROUTES.callbackPath,
    code,
    integration,
    oauthPath: `${TEST_ROUTES.oauthPath}?credentialId=${FIRST_OAUTH_ID}`,
    state,
  });
}

async function setupConnectedCredential() {
  const setup = setupIntegration();
  await connectAccount(
    setup.integration,
    FIRST_STATE,
    "authorization-code-one",
  );
  return {
    ...setup,
    store: new ProviderCredentialStore(
      setup.database,
      createCredentialCipher(ENVIRONMENT.OPENAI_CREDENTIAL_KEY),
      "openai",
    ),
  };
}

function markForReconnect(store: ProviderCredentialStore): string | undefined {
  store.markRequiresReauthentication(TEST_USER_ID, FIRST_OAUTH_ID, TEST_NOW);
  return store.readSecret(TEST_USER_ID, FIRST_OAUTH_ID);
}

function expectStoredSecret(
  store: ProviderCredentialStore,
  expected: string | undefined,
): void {
  expect(store.readSecret(TEST_USER_ID, FIRST_OAUTH_ID)).toBe(expected);
}

async function expectWrongAccount(
  integration: ReturnType<typeof setupIntegration>["integration"],
  reconnect: ReturnType<typeof beginReconnect>,
): Promise<void> {
  expectRedirect(
    await integration.complete(reconnect.callbackRequest),
    "http://localhost:3000/app?openai=wrong_account",
  );
}

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
      createHash("sha256").update(FIRST_VERIFIER).digest("base64url"),
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

    await addProviderApiKeys(integration, TEST_ROUTES.credentialsPath, [
      FIRST_MANUAL_KEY,
      SECOND_MANUAL_KEY,
    ]);

    const listResponse = await integration.credentials(
      createAuthenticatedRequest(TEST_ROUTES.credentialsPath),
    );
    expect(await listResponse.json()).toEqual(
      credentialSummaries([
        FIRST_OAUTH_CREDENTIAL,
        SECOND_OAUTH_CREDENTIAL,
        FIRST_MANUAL_CREDENTIAL,
        SECOND_MANUAL_CREDENTIAL,
      ]),
    );

    const storedCredentials = readStoredProviderCredentials(database, "openai");
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
    ).toBe(true);

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

    try {
      expectRemovedProviderCredential(
        { database, integration, providerRequests },
        TEST_ROUTES,
        FIRST_KEY_ID,
      );
    } finally {
      database.$client.close();
    }
  });

  test("reconnects only the flagged credential for the same verified account", async () => {
    const { database, integration, store } = await setupConnectedCredential();

    for (const query of [
      `credentialId=${FIRST_OAUTH_ID}`,
      "credentialId=another-users-credential",
      `workspaceId=out-of-scope&credentialId=${FIRST_OAUTH_ID}`,
    ]) {
      expect(
        integration.begin(
          createAuthenticatedRequest(`${TEST_ROUTES.oauthPath}?${query}`),
        ).status,
      ).toBe(409);
    }

    store.markRequiresReauthentication(TEST_USER_ID, FIRST_OAUTH_ID, TEST_NOW);
    const reconnect = beginReconnect(integration, "openai-state-five");
    expect(readFlowCookies(reconnect.beginResponse)).toContain(
      `q_mush_openai_credential=${FIRST_OAUTH_ID}`,
    );
    expectRedirect(
      await integration.complete(reconnect.callbackRequest),
      "http://localhost:3000/app?openai=connected",
    );
    expect(store.list(TEST_USER_ID)).toContainEqual(
      expect.objectContaining({
        accountId: "chatgpt-workspace-one",
        id: FIRST_OAUTH_ID,
        isDefault: false,
        requiresReauthentication: false,
      }),
    );

    const endpointReconnect = vi
      .spyOn(ProviderCredentialStore.prototype, "updateSecret")
      .mockReturnValue(true);
    store.markRequiresReauthentication(TEST_USER_ID, FIRST_OAUTH_ID, TEST_NOW);
    const unflagged = beginReconnect(integration, "openai-state-six");
    database
      .update(providerCredentials)
      .set({ requiresReauthentication: false })
      .where(eq(providerCredentials.id, FIRST_OAUTH_ID))
      .run();
    await expectWrongAccount(integration, unflagged);

    const unchangedSecret = markForReconnect(store);
    const wrongAccount = beginReconnect(
      integration,
      "openai-state-seven",
      "authorization-code-two",
    );
    await expectWrongAccount(integration, wrongAccount);
    expectStoredSecret(store, unchangedSecret);

    database
      .update(providerCredentials)
      .set({ providerAccountId: null })
      .where(eq(providerCredentials.id, FIRST_OAUTH_ID))
      .run();
    const missingStoredIdentity = beginReconnect(
      integration,
      "openai-state-eight",
    );
    await expectWrongAccount(integration, missingStoredIdentity);
    expect(endpointReconnect).not.toHaveBeenCalled();
    endpointReconnect.mockRestore();
    database.$client.close();
  });

  test("rejects an account changed during the callback", async () => {
    const setup = await setupConnectedCredential();
    const { database, integration, store } = setup;
    const unchangedSecret = markForReconnect(store);
    const originalUpdateSecret = store.updateSecret.bind(store);
    const updateSecret = vi
      .spyOn(ProviderCredentialStore.prototype, "updateSecret")
      .mockImplementation((...parameters) => {
        const reconnectOnly = parameters[4] === true;
        if (reconnectOnly) {
          database
            .update(providerCredentials)
            .set({ providerAccountId: "chatgpt-workspace-two" })
            .where(eq(providerCredentials.id, FIRST_OAUTH_ID))
            .run();
        }
        return originalUpdateSecret(...parameters);
      });

    try {
      const reconnect = beginReconnect(integration, SECOND_STATE);
      await expectWrongAccount(integration, reconnect);
      expect(store.readSecret(TEST_USER_ID, FIRST_OAUTH_ID)).toBe(
        unchangedSecret,
      );
    } finally {
      updateSecret.mockRestore();
      database.$client.close();
    }
  });

  test("rejects an OAuth callback with unverifiable state", () =>
    expectInvalidProviderState(
      setupIntegration(),
      TEST_ROUTES,
      "authorization-code-one",
    ));

  test("protects access and rejects an invalid API key", () =>
    expectProtectedInvalidApiKey(setupIntegration(), TEST_ROUTES));

  test("uses the registered Codex loopback callback by default", async () => {
    const setupLoopbackIntegration = createProviderTestSetup(
      defineProviderTestConfiguration(
        createProviderFetch,
        { OPENAI_CREDENTIAL_KEY: ENVIRONMENT.OPENAI_CREDENTIAL_KEY },
        createOpenAiIntegrationFromEnvironment,
        [FIRST_OAUTH_ID],
        "openai",
        [FIRST_STATE, FIRST_VERIFIER],
      ),
    );
    const { database, integration } = setupLoopbackIntegration();
    const { authorizationUrl, callbackRequest } = beginProviderAccount({
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
    ).toBe(true);

    expect(
      response.headers
        .getSetCookie()
        .every((cookie) => cookie.includes("Max-Age=0")),
    ).toBe(true);
    database.$client.close();
  });
});
