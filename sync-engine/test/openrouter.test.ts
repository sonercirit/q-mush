import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import { ProviderCredentialStore } from "../../shared/provider-credential-store.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createOpenRouterIntegrationFromEnvironment } from "../../sync-engine/openrouter.ts";
import {
  createAuthenticatedRequest,
  readFlowCookies,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { expectPkceParameters, expectRedirect } from "./oauth-test-helpers.ts";
import { unavailableProviderResponse } from "./provider-fetch-fixtures.ts";
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
  expectProviderCredentialSummaries,
  expectRemovedProviderCredential,
  providerKeyDetailsResponse,
  readBearerApiKey,
  readProviderCredentialSummaries,
  readStoredProviderCredentials,
  recordProviderRequest,
  setProviderDefaults,
} from "./provider-integration-test-helpers.ts";

const OAUTH_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000023";
const FIRST_KEY_ID = "018bcfe5-6800-7000-8000-000000000024";
const SECOND_KEY_ID = "018bcfe5-6800-7000-8000-000000000025";
const STATE = "openrouter-state";
const VERIFIER = "openrouter-verifier";
const OAUTH_KEY = "sk-or-v1-oauth-secret";
const FIRST_KEY = "sk-or-v1-first-manual-secret";
const SECOND_KEY = "sk-or-v1-second-manual-secret";
const createRequest = createAuthenticatedRequest;
const flowCookies = readFlowCookies;
const CALLBACK_URL = "http://localhost:3000/api/openrouter/oauth/callback";
const ENVIRONMENT = {
  OPENROUTER_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
  OPENROUTER_REDIRECT_URI: CALLBACK_URL,
};
const OAUTH_CREDENTIAL = {
  accountId: "openrouter-account-oauth",
  id: OAUTH_CREDENTIAL_ID,
  isDefault: false,
  label: "OpenRouter account",
  source: "oauth",
};
const FIRST_MANUAL_CREDENTIAL = {
  accountId: "openrouter-account-first",
  id: FIRST_KEY_ID,
  isDefault: false,
  label: "First manual key",
  source: "api_key",
};
const SECOND_MANUAL_CREDENTIAL = {
  accountId: "openrouter-account-second",
  id: SECOND_KEY_ID,
  isDefault: false,
  label: "Second manual key",
  source: "api_key",
};

const MANUAL_KEY_DETAILS = {
  [FIRST_KEY]: {
    accountId: "openrouter-account-first",
    label: "First manual key",
  },
  [SECOND_KEY]: {
    accountId: "openrouter-account-second",
    label: "Second manual key",
  },
};

interface KeyDetails {
  readonly accountId: string;
  readonly label: string;
  oauthAccountId?: string | null;
}

function createProviderFetch(
  detailsByKey: Readonly<Record<string, KeyDetails>>,
  requests: Request[],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const request = recordProviderRequest(requests, input, init);

    if (request.url === "https://openrouter.ai/api/v1/auth/keys") {
      const oauthAccountId = detailsByKey[OAUTH_KEY]?.oauthAccountId;
      return Promise.resolve(
        Response.json({
          key: OAUTH_KEY,
          ...(oauthAccountId === null
            ? {}
            : { user_id: oauthAccountId ?? "openrouter-account-oauth" }),
        }),
      );
    }

    if (request.url === "https://openrouter.ai/api/v1/key") {
      const details = detailsByKey[readBearerApiKey(request)];

      return Promise.resolve(providerKeyDetailsResponse(details));
    }

    return unavailableProviderResponse();
  };
}

const TEST_ROUTES = defineProviderTestRoutes("openrouter");
const INTEGRATION_TEST_CONFIGURATION = defineProviderTestConfiguration(
  createProviderFetch,
  ENVIRONMENT,
  createOpenRouterIntegrationFromEnvironment,
  [OAUTH_CREDENTIAL_ID, FIRST_KEY_ID, SECOND_KEY_ID],
  "openrouter",
  [STATE, VERIFIER, "openrouter-state-two", "openrouter-verifier-two"],
);

const setupIntegration = createProviderTestSetup(
  INTEGRATION_TEST_CONFIGURATION,
);
const setupDefaultIntegration = createProviderTestSetup({
  ...INTEGRATION_TEST_CONFIGURATION,
  ids: [FIRST_KEY_ID, SECOND_KEY_ID],
  tokens: [],
});
const connectAccount = createProviderAccountConnector(TEST_ROUTES);

describe("OpenRouter credentials", () => {
  test("rejects reconnect when OpenRouter omits the account identity", async () => {
    const { database, integration } = setupIntegration({
      [OAUTH_KEY]: {
        accountId: "unused",
        label: "unused",
        oauthAccountId: null,
      },
    });
    await connectAccount(integration, STATE, "authorization-code");
    const store = new ProviderCredentialStore(
      database,
      createCredentialCipher(ENVIRONMENT.OPENROUTER_CREDENTIAL_KEY),
      "openrouter",
    );
    store.markRequiresReauthentication(
      TEST_USER_ID,
      OAUTH_CREDENTIAL_ID,
      TEST_NOW,
    );
    const unchangedSecret = store.readSecret(TEST_USER_ID, OAUTH_CREDENTIAL_ID);
    const reconnect = beginProviderAccount({
      callbackPath: TEST_ROUTES.callbackPath,
      code: "authorization-code",
      integration,
      oauthPath: `${TEST_ROUTES.oauthPath}?credentialId=${OAUTH_CREDENTIAL_ID}`,
      state: "openrouter-state-two",
    });

    expectRedirect(
      await integration.complete(reconnect.callbackRequest),
      "http://localhost:3000/app?openrouter=wrong_account",
    );
    expect(store.readSecret(TEST_USER_ID, OAUTH_CREDENTIAL_ID)).toBe(
      unchangedSecret,
    );
    database.$client.close();
  });

  test("connects accounts with OAuth PKCE and stores multiple accounts or keys", async () => {
    const { database, integration, providerRequests } =
      setupIntegration(MANUAL_KEY_DETAILS);
    const {
      authorizationUrl,
      beginResponse,
      response: callbackResponse,
    } = await connectAccount(integration, STATE, "authorization-code");
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

    expectRedirect(
      callbackResponse,
      "http://localhost:3000/app?openrouter=connected",
    );

    const manualKeys = [FIRST_KEY, SECOND_KEY];
    await addProviderApiKeys(
      integration,
      TEST_ROUTES.credentialsPath,
      manualKeys,
    );

    const listResponse = await integration.credentials(
      createRequest(TEST_ROUTES.credentialsPath),
    );

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual(
      credentialSummaries([
        OAUTH_CREDENTIAL,
        FIRST_MANUAL_CREDENTIAL,
        SECOND_MANUAL_CREDENTIAL,
      ]),
    );

    const storedCredentials = readStoredProviderCredentials(
      database,
      "openrouter",
    );
    expect(storedCredentials).toHaveLength(3);
    expect(
      storedCredentials.every(
        ({ encryptedCredential }) =>
          ![OAUTH_KEY, FIRST_KEY, SECOND_KEY].some((key) =>
            encryptedCredential.includes(key),
          ),
      ),
    ).toBe(true);
    expect(providerRequests[0]?.method).toBe("POST");
    expect(await providerRequests[0]?.json()).toEqual({
      code: "authorization-code",
      code_challenge_method: "S256",
      code_verifier: VERIFIER,
    });

    expectRemovedProviderCredential(
      { database, integration, providerRequests },
      TEST_ROUTES,
      FIRST_KEY_ID,
    );
    expectProviderCredentialSummaries(
      await readProviderCredentialSummaries(
        integration,
        TEST_ROUTES.credentialsPath,
      ),
      [OAUTH_CREDENTIAL, SECOND_MANUAL_CREDENTIAL],
    );

    database.$client.close();
  });

  test("sets one model credential as the user's default", async () => {
    const { database, integration } =
      setupDefaultIntegration(MANUAL_KEY_DETAILS);
    await addProviderApiKeys(
      integration,
      TEST_ROUTES.credentialsPath,
      Object.keys(MANUAL_KEY_DETAILS),
    );

    expect(
      setProviderDefaults(integration, TEST_ROUTES.credentialsPath, [
        FIRST_KEY_ID,
        SECOND_KEY_ID,
        "missing",
      ]),
    ).toEqual([204, 204, 404]);
    expectProviderCredentialSummaries(
      await readProviderCredentialSummaries(
        integration,
        TEST_ROUTES.credentialsPath,
      ),
      [
        { ...FIRST_MANUAL_CREDENTIAL, isDefault: false },
        { ...SECOND_MANUAL_CREDENTIAL, isDefault: true },
      ],
    );
    database.$client.close();
  });

  test("does not exchange a callback whose state cannot be verified", async () => {
    await expectInvalidProviderState(
      setupIntegration(),
      TEST_ROUTES,
      "authorization-code",
    );
  });

  test("requires login and rejects invalid manually supplied keys", async () => {
    await expectProtectedInvalidApiKey(setupIntegration(), TEST_ROUTES);
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
