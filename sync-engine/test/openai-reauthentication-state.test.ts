import { Buffer } from "node:buffer";
import { afterEach, describe, expect, test } from "vitest";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import {
  type ProviderCredentialStore,
  createProviderCredentialStore,
} from "../../shared/provider-credential-store.ts";
import { createOpenAiIntegrationFromEnvironment } from "../openai.ts";
import { isProviderCredentialReauthenticationRequiredError } from "../provider-error.ts";
import {
  addTestProviderCredential,
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { closeTrackedDatabases } from "./database-test-helpers.ts";
import { promiseGate } from "./session-race-test-helpers.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000099";
const CREDENTIAL_KEY = Buffer.alloc(32, 13).toString("base64url");
const REVOKED_SECRET = JSON.stringify({
  access: "revoked-access",
  expires: TEST_NOW + 7 * 24 * 60 * 60 * 1_000,
  refresh: "revoked-refresh",
});
const EXTERNAL_ROTATION_SECRET = JSON.stringify({
  access: "external-access",
  expires: TEST_NOW + 7_200_000,
  refresh: "external-refresh",
});
const databases: ReturnType<
  typeof createAuthenticatedTestContext
>["database"][] = [];

function openAiRefreshTestContext() {
  const { auth, database } = createAuthenticatedTestContext();
  databases.unshift(database);
  return { auth, database };
}

function closeRefreshDatabases(): void {
  closeTrackedDatabases(databases);
}

afterEach(closeRefreshDatabases);

function setupRefresh(
  response: Response | Promise<Response> | (() => Response | Promise<Response>),
) {
  const { auth, database } = openAiRefreshTestContext();
  const store = createProviderCredentialStore(
    database,
    createCredentialCipher(CREDENTIAL_KEY),
    "openai",
    () => CREDENTIAL_ID,
  );
  store.add(
    TEST_USER_ID,
    REVOKED_SECRET,
    { accountId: "account", label: "OpenAI account" },
    "oauth",
    TEST_NOW,
  );
  const environment = {
    OPENAI_CREDENTIAL_KEY: CREDENTIAL_KEY,
    OPENAI_CLIENT_ID: "test-client",
  };
  let refreshRequests = 0;
  const dependencies = {
    database,
    fetch: () => {
      refreshRequests += 1;
      return Promise.resolve(
        typeof response === "function" ? response() : response,
      );
    },
    now: () => TEST_NOW,
  };
  const integration = createOpenAiIntegrationFromEnvironment(
    environment,
    auth,
    dependencies,
  );
  return {
    database,
    integration,
    refreshRequests: () => refreshRequests,
    store,
  };
}

function expectReauthenticationState(
  store: ProviderCredentialStore,
  required: boolean,
): void {
  expect(store.list(TEST_USER_ID)).toContainEqual(
    expect.objectContaining({
      id: CREDENTIAL_ID,
      requiresReauthentication: required,
    }),
  );
}

function gatedRefreshSetup() {
  const refresh = promiseGate<Response>();
  return { refresh, setup: setupRefresh(refresh.wait()) };
}

function forceRefresh(
  setup: ReturnType<typeof setupRefresh>,
  rejectedSecret?: string,
): ReturnType<typeof setup.integration.readCredential> {
  return setup.integration.readCredential(
    TEST_USER_ID,
    CREDENTIAL_ID,
    undefined,
    {
      force: true,
      ...(rejectedSecret === undefined ? {} : { rejectedSecret }),
    },
  );
}

function rotateCredential(
  setup: ReturnType<typeof setupRefresh>,
  secret: string,
): void {
  setup.store.updateSecret(TEST_USER_ID, CREDENTIAL_ID, secret, TEST_NOW);
}

function sequentialResponses(
  ...responses: (Response | Promise<Response>)[]
): () => Response | Promise<Response> {
  let index = 0;
  return () => {
    const response = responses[index];
    index += 1;
    if (response !== undefined) return response;
    throw new Error("Unexpected extra refresh request");
  };
}

function rejectedRefreshResponse(): Response {
  return Response.json({ error: "refresh_token_reused" }, { status: 401 });
}

function releaseSuccessfulRefresh(
  refresh: ReturnType<typeof promiseGate<Response>>,
): void {
  refresh.release(
    Response.json({
      access_token: "replacement-access",
      expires_in: 3_600,
      refresh_token: "replacement-refresh",
    }),
  );
}

function replacementSecret(): string {
  return JSON.stringify({
    access: "replacement-access",
    expires: TEST_NOW + 3_600_000,
    refresh: "replacement-refresh",
  });
}

describe("OpenAI terminal OAuth refresh rejection", () => {
  test("coalesces concurrent forced refreshes and persists the rotated token once", async () => {
    const gated = gatedRefreshSetup();
    const { refresh, setup } = gated;
    const first = forceRefresh(setup);
    const second = forceRefresh(setup);

    await refresh.entered;
    releaseSuccessfulRefresh(refresh);

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { secret: replacementSecret() },
      { secret: replacementSecret() },
    ]);
    expect(setup.refreshRequests()).toBe(1);
    expectReauthenticationState(setup.store, false);
  });

  test("ignores a stale refresh rejection after another request rotates the credential", async () => {
    const { refresh, setup } = gatedRefreshSetup();
    const first = forceRefresh(setup);

    await refresh.entered;
    rotateCredential(setup, EXTERNAL_ROTATION_SECRET);
    const lateUnauthorized = forceRefresh(setup, REVOKED_SECRET);
    refresh.release(rejectedRefreshResponse());

    await expect(lateUnauthorized).resolves.toMatchObject({
      secret: EXTERNAL_ROTATION_SECRET,
    });
    await expect(first).resolves.toMatchObject({
      secret: EXTERNAL_ROTATION_SECRET,
    });
    expect(setup.refreshRequests()).toBe(1);
    const [listed] = setup.store.list(TEST_USER_ID);
    expect(listed?.requiresReauthentication).toBe(false);
  });

  test("reuses an already rotated credential without issuing another refresh", async () => {
    const setup = setupRefresh(
      Response.json({ error: "unexpected" }, { status: 500 }),
    );
    rotateCredential(setup, EXTERNAL_ROTATION_SECRET);

    await expect(
      forceRefresh(setup, replacementSecret()),
    ).resolves.toMatchObject({ secret: EXTERNAL_ROTATION_SECRET });
    expect(setup.refreshRequests()).toBe(0);
  });

  test("forces a fresh refresh after an unrelated stale preparation is in flight", async () => {
    const staleRefresh = promiseGate<Response>();
    const setup = setupRefresh(
      sequentialResponses(
        staleRefresh.wait(),
        Response.json({
          access_token: "forced-access",
          expires_in: 3_600,
          refresh_token: "forced-refresh",
        }),
      ),
    );
    const stale = forceRefresh(setup);
    await staleRefresh.entered;
    rotateCredential(setup, EXTERNAL_ROTATION_SECRET);

    const forced = forceRefresh(setup, EXTERNAL_ROTATION_SECRET);
    await expect.poll(setup.refreshRequests).toBe(2);
    const refreshRequestsBeforeStaleResolution = setup.refreshRequests();
    staleRefresh.release(rejectedRefreshResponse());

    const forcedSecret = JSON.stringify({
      access: "forced-access",
      expires: TEST_NOW + 3_600_000,
      refresh: "forced-refresh",
    });
    await expect(forced).resolves.toMatchObject({ secret: forcedSecret });
    await expect(stale).resolves.toMatchObject({ secret: forcedSecret });
    expect(refreshRequestsBeforeStaleResolution).toBe(2);
    expect(setup.refreshRequests()).toBe(2);
  });

  test("cannot mark another user's or provider's credential", () => {
    const { database } = openAiRefreshTestContext();
    addTestUser(database);
    addTestProviderCredential(database, "foreign-credential", "openai", {
      source: "oauth",
      userId: TEST_FOREIGN_USER_ID,
    });
    addTestProviderCredential(database, "openrouter-credential", "openrouter", {
      source: "oauth",
    });
    const openAiStore = createProviderCredentialStore(
      database,
      createCredentialCipher(CREDENTIAL_KEY),
      "openai",
    );

    expect(
      openAiStore.markRequiresReauthentication(
        TEST_USER_ID,
        "openrouter-credential",
        TEST_NOW,
      ),
    ).toBe(false);
    expect(
      openAiStore.markRequiresReauthentication(
        TEST_USER_ID,
        "foreign-credential",
        TEST_NOW,
      ),
    ).toBe(false);
  });

  test.each([
    [401, "refresh_token_invalidated"],
    [403, "forbidden"],
    [400, "invalid_grant"],
    [400, "invalid_client"],
    [400, "refresh_token_expired"],
    [400, "refresh_token_reused"],
  ])(
    "marks the credential for re-login after status %i",
    async (status, code) => {
      const setup = setupRefresh(Response.json({ error: code }, { status }));

      const failure = forceRefresh(setup);
      await expect(failure).rejects.toSatisfy(
        isProviderCredentialReauthenticationRequiredError,
      );
      expectReauthenticationState(setup.store, true);
      const summaries = await setup.integration.credentials(
        createAuthenticatedRequest("/api/openai/credentials"),
      );
      const serialized = await summaries.text();
      expect(serialized).toContain('"requiresReauthentication":true');
      expect(serialized).not.toContain("revoked-access");
      expect(serialized).not.toContain("revoked-refresh");
    },
  );

  test("only replaces a flagged credential for its verified account once", () => {
    const setup = setupRefresh(Response.json({ error: "unused" }));
    setup.store.markRequiresReauthentication(
      TEST_USER_ID,
      CREDENTIAL_ID,
      TEST_NOW + 1,
    );
    const cannotUpdate = setup.store.updateSecret(
      "another-user",
      CREDENTIAL_ID,
      "attacker-secret",
      TEST_NOW + 1,
    );
    expect(cannotUpdate).toBe(false);
    const cannotMark = setup.store.markRequiresReauthentication(
      "another-user",
      CREDENTIAL_ID,
      TEST_NOW + 1,
    );
    expect(cannotMark).toBe(false);
    expect(
      setup.store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        "missing-account-secret",
        TEST_NOW + 2,
        true,
      ),
    ).toBe(false);
    expect(
      setup.store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        "mismatched-account-secret",
        TEST_NOW + 2,
        true,
        "another-account",
      ),
    ).toBe(false);
    const readSecret = (): string | undefined =>
      setup.store.readSecret(TEST_USER_ID, CREDENTIAL_ID);
    expect(readSecret()).toBe(REVOKED_SECRET);
    expectReauthenticationState(setup.store, true);
    expect(
      setup.store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        replacementSecret(),
        TEST_NOW + 2,
        true,
        "account",
      ),
    ).toBe(true);
    expect(
      setup.store.updateSecret(
        TEST_USER_ID,
        CREDENTIAL_ID,
        "stale-callback-secret",
        TEST_NOW + 3,
        true,
        "account",
      ),
    ).toBe(false);
    expect(readSecret()).toBe(replacementSecret());
    expectReauthenticationState(setup.store, false);
  });
});
