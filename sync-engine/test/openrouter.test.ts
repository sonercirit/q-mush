import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createOpenRouterIntegrationFromEnvironment } from "../../sync-engine/openrouter.ts";
import { ProviderLimitStore } from "../../sync-engine/provider-limit-store.ts";
import { ProviderLimitsService } from "../../sync-engine/provider-limits-service.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  readFlowCookies,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { expectPkceParameters, expectRedirect } from "./oauth-test-helpers.ts";
import {
  addProviderApiKeys,
  createProviderAccountConnector,
  createProviderTestSetup,
  credentialSummaries,
  defineProviderTestConfiguration,
  defineProviderTestRoutes,
  expectInvalidProviderState,
  expectProtectedInvalidApiKey,
  expectProviderCredentialSummaries,
  expectRemovedProviderCredential,
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

function recordingSocket(messages: string[]) {
  return {
    close: () => undefined,
    send: (message: string) => {
      messages.push(message);
      return 1;
    },
  };
}

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

function keyCreditLimits(
  id: string,
  limit: number,
  remaining: number,
  used: number,
  additionalDimensions: readonly {
    readonly key: string;
    readonly used: number;
  }[] = [],
) {
  return {
    id,
    limits: {
      dimensions: [
        { key: "key_credits", limit, remaining, used },
        ...additionalDimensions,
      ],
      provider: "openrouter",
      source: "credential_metadata",
      status: "available",
    },
  };
}

async function expectCredentialLimits(
  integration: Parameters<typeof readProviderCredentialSummaries>[0],
  expected: unknown,
): Promise<unknown> {
  const body = await readProviderCredentialSummaries(
    integration,
    TEST_ROUTES.credentialsPath,
  );
  expect(body).toMatchObject({ credentials: [expected] });
  return body;
}

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
  readonly exposeLimits?: boolean;
  readonly label: string;
}

function createProviderFetch(
  detailsByKey: Readonly<Record<string, KeyDetails>>,
  requests: Request[],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const request = recordProviderRequest(requests, input, init);

    if (request.url === "https://openrouter.ai/api/v1/auth/keys") {
      return Promise.resolve(
        Response.json({
          key: OAUTH_KEY,
          ...(detailsByKey[OAUTH_KEY]?.exposeLimits === true
            ? { limit: 200, limit_remaining: 150, usage: 50 }
            : {}),
          user_id: "openrouter-account-oauth",
        }),
      );
    }

    if (request.url === "https://openrouter.ai/api/v1/key") {
      const details = detailsByKey[readBearerApiKey(request)];

      return Promise.resolve(
        details === undefined
          ? Response.json({ error: "invalid key" }, { status: 401 })
          : Response.json({
              data: {
                creator_user_id: details.accountId,
                label: details.label,
                ...(details.exposeLimits === true
                  ? {
                      limit: 100,
                      limit_remaining: 25,
                      usage: 75,
                      usage_daily: 3,
                      usage_monthly: 20,
                      usage_weekly: 8,
                    }
                  : {}),
              },
            }),
      );
    }

    return Promise.resolve(new Response(null, { status: 500 }));
  };
}

const TEST_ROUTES = defineProviderTestRoutes("openrouter");
const INTEGRATION_TEST_CONFIGURATION = defineProviderTestConfiguration(
  createProviderFetch,
  ENVIRONMENT,
  createOpenRouterIntegrationFromEnvironment,
  [OAUTH_CREDENTIAL_ID, FIRST_KEY_ID, SECOND_KEY_ID],
  "openrouter",
  [STATE, VERIFIER],
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

  test("publishes validated credential metadata only to the authenticated owner", async () => {
    const { auth, database } = createAuthenticatedTestContext();
    const hub = new RealtimeHub();
    const ownerMessages: string[] = [];
    const otherMessages: string[] = [];
    hub.setUser(TEST_USER_ID, recordingSocket(ownerMessages), true);
    hub.setUser("other-user", recordingSocket(otherMessages), true);
    const limits = new ProviderLimitsService(
      new ProviderLimitStore(database, () => FIRST_KEY_ID),
      () => TEST_NOW,
      hub,
    );
    const validationDetails = {
      ...MANUAL_KEY_DETAILS[FIRST_KEY],
      exposeLimits: true,
    };
    const integration = createOpenRouterIntegrationFromEnvironment(
      ENVIRONMENT,
      auth,
      {
        database,
        fetch: createProviderFetch({ [FIRST_KEY]: validationDetails }, []),
        limits,
        now: () => TEST_NOW,
        randomId: () => FIRST_KEY_ID,
      },
    );

    await addProviderApiKeys(integration, TEST_ROUTES.credentialsPath, [
      FIRST_KEY,
    ]);

    expect(
      ownerMessages.map((message): unknown => JSON.parse(message)),
    ).toMatchObject([
      {
        credentialId: FIRST_KEY_ID,
        limits: {
          provider: "openrouter",
          source: "credential_metadata",
          status: "available",
        },
        type: "provider_limits",
      },
    ]);
    expect(otherMessages).toEqual([]);
    expect(ownerMessages.join("")).not.toContain(FIRST_KEY);
    database.$client.close();
  });

  test("captures safe credit metadata from the existing OAuth key response", async () => {
    const { database, integration, providerRequests } = setupIntegration({
      [OAUTH_KEY]: {
        accountId: "unused",
        exposeLimits: true,
        label: "unused",
      },
    });
    await connectAccount(integration, STATE, "authorization-code");

    const body = await expectCredentialLimits(
      integration,
      keyCreditLimits(OAUTH_CREDENTIAL_ID, 200, 150, 50),
    );
    expect(providerRequests).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(OAUTH_KEY);
    database.$client.close();
  });

  test("captures safe key credit metadata during validation", async () => {
    const setup = setupDefaultIntegration({
      [FIRST_KEY]: {
        ...MANUAL_KEY_DETAILS[FIRST_KEY],
        exposeLimits: true,
      },
    });
    const { integration } = setup;
    await addProviderApiKeys(integration, TEST_ROUTES.credentialsPath, [
      FIRST_KEY,
    ]);

    const body = await expectCredentialLimits(
      integration,
      keyCreditLimits(FIRST_KEY_ID, 100, 25, 75, [
        { key: "daily_usage", used: 3 },
        { key: "weekly_usage", used: 8 },
        { key: "monthly_usage", used: 20 },
      ]),
    );
    expect(JSON.stringify(body)).not.toContain(FIRST_KEY);
    setup.database.$client.close();
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
