import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import {
  providerQuotaResetReceipts,
  providerQuotaSettings,
} from "../../shared/database/schema.ts";
import { ProviderQuotaStore } from "../../shared/provider-quota-store.ts";
import { codexUsageFixture } from "../../shared/test/provider-quota-fixtures.ts";
import { createOpenAiIntegrationFromEnvironment } from "../../sync-engine/openai.ts";
import {
  createAuthenticatedRequest,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { oauthTokenResponse } from "./oauth-test-fixtures.ts";
import { unavailableProviderResponse } from "./provider-fetch-fixtures.ts";
import {
  createProviderAccountConnector,
  createProviderTestSetup,
  defineProviderTestConfiguration,
  defineProviderTestRoutes,
  withOpenAiProviderRequest,
} from "./provider-integration-test-helpers.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000091";
const QUOTA_SETTING_ID = "018bcfe5-6800-7000-8000-000000000092";
const QUOTA_RECEIPT_ID = "018bcfe5-6800-7000-8000-000000000093";
const STATE = "quota-state";
const VERIFIER = "quota-verifier";
const ACCOUNT_ID = "chatgpt-quota-account";
const ACCESS_TOKEN = "chatgpt-quota-access";
const ID_TOKEN = `${Buffer.from("header").toString("base64url")}.${Buffer.from(
  JSON.stringify({
    email: "quota@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID },
  }),
).toString("base64url")}.signature`;
const ENVIRONMENT = {
  OPENAI_CLIENT_ID: "quota-client",
  OPENAI_CREDENTIAL_KEY: Buffer.alloc(32, 4).toString("base64url"),
  OPENAI_REDIRECT_URI: "http://localhost:3000/api/openai/oauth/callback",
};

interface QuotaProviderState {
  readonly consume?: () => Promise<Response>;
  readonly remaining: number;
  readonly resets: number;
}

function createProviderFetch(
  states: Readonly<Record<string, QuotaProviderState>>,
  requests: Request[],
) {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    withOpenAiProviderRequest({
      init,
      input,
      onRequest: (request, token) => {
        if (token) {
          return Promise.resolve(
            oauthTokenResponse({
              accessToken: ACCESS_TOKEN,
              idToken: ID_TOKEN,
              refreshToken: "quota-refresh",
            }),
          );
        }
        if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
          return Promise.resolve(
            Response.json(
              codexUsageFixture({
                availableResetCount: states[ACCOUNT_ID]?.resets ?? 0,
                now: TEST_NOW,
                remainingPercent: states[ACCOUNT_ID]?.remaining ?? 50,
              }),
            ),
          );
        }
        if (
          request.url ===
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
        ) {
          return (
            states[ACCOUNT_ID]?.consume?.() ??
            Promise.resolve(Response.json({ code: "reset", windows_reset: 1 }))
          );
        }
        return unavailableProviderResponse();
      },
      requests,
    });
}

const ROUTES = defineProviderTestRoutes("openai");
const setup = createProviderTestSetup(
  defineProviderTestConfiguration(
    createProviderFetch,
    ENVIRONMENT,
    createOpenAiIntegrationFromEnvironment,
    [CREDENTIAL_ID, QUOTA_SETTING_ID, QUOTA_RECEIPT_ID],
    "openai",
    [STATE, VERIFIER],
  ),
);
const connect = createProviderAccountConnector(ROUTES);

function quotaRequest(
  path: string,
  body?: Record<string, unknown>,
  method = "GET",
) {
  return createAuthenticatedRequest(path, body, method);
}

async function connectedQuotaSetup(
  remaining: number,
  resets: number,
  consume?: () => Promise<Response>,
) {
  const result = setup({
    [ACCOUNT_ID]: {
      remaining,
      resets,
      ...(consume === undefined ? {} : { consume }),
    },
  });
  await connect(result.integration, STATE, "quota-code");
  return result;
}

function consumedRequests(requests: readonly Request[]): readonly Request[] {
  return requests.filter(({ url }) => url.endsWith("/consume"));
}

function resetRequest(
  integration: Awaited<ReturnType<typeof connectedQuotaSetup>>["integration"],
  clientRequestId: string,
) {
  return integration.resetQuota(
    quotaRequest(
      `${ROUTES.credentialsPath}/${CREDENTIAL_ID}/quota/reset`,
      { clientRequestId },
      "POST",
    ),
    CREDENTIAL_ID,
  );
}

function expectResetResult(
  response: Response,
  replayed: boolean,
): Promise<void> {
  expect(response.status).toBe(200);
  return expect(response.json()).resolves.toMatchObject({
    outcome: "reset",
    replayed,
  });
}

function closeQuotaSetup(database: {
  readonly $client: { close(): void };
}): void {
  database.$client.close();
}

function readResetReceipts(database: AppDatabase) {
  return database.select().from(providerQuotaResetReceipts).all();
}

function expectOnlyResetReceipt(
  database: AppDatabase,
  expected: Partial<(typeof providerQuotaResetReceipts)["$inferSelect"]>,
): void {
  const receipts = readResetReceipts(database);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject(expected);
}

async function consumedRequestBodies(
  requests: readonly Request[],
): Promise<unknown[]> {
  return Promise.all(
    consumedRequests(requests).map((request) => request.clone().json()),
  );
}

describe("provider quota endpoints", () => {
  test("persists the default and updated auto-reset threshold", async () => {
    const { database, integration } = await connectedQuotaSetup(40, 2);
    const path = `${ROUTES.credentialsPath}/${CREDENTIAL_ID}/quota`;

    expect(
      await (await integration.quota(quotaRequest(path), CREDENTIAL_ID)).json(),
    ).toMatchObject({ autoResetThresholdPercent: 1, bankedResetCount: 2 });
    expect(
      (
        await integration.setQuotaThreshold(
          quotaRequest(
            `${path}/threshold`,
            { autoResetThresholdPercent: 2.5 },
            "PUT",
          ),
          CREDENTIAL_ID,
        )
      ).status,
    ).toBe(204);
    expect(database.select().from(providerQuotaSettings).get()).toMatchObject({
      autoResetThresholdPercent: 2.5,
      providerCredentialId: CREDENTIAL_ID,
    });
    closeQuotaSetup(database);
  });

  test("deduplicates reset request IDs and keeps concurrent requests from double-spending", async () => {
    const { database, integration, providerRequests } =
      await connectedQuotaSetup(5, 2);
    const request = () => resetRequest(integration, "reset-once");

    const first = await request();
    const replay = await request();

    await expectResetResult(first, false);
    await expectResetResult(replay, true);
    expect(consumedRequests(providerRequests)).toHaveLength(1);
    closeQuotaSetup(database);
  });

  test("keeps an in-flight reset leased to one provider idempotency key", async () => {
    const consumeResult = Promise.withResolvers<Response>();
    const consumeStarted = Promise.withResolvers<undefined>();
    const { database, integration, providerRequests } =
      await connectedQuotaSetup(5, 2, () => {
        consumeStarted.resolve();
        return consumeResult.promise;
      });
    const firstResponse = resetRequest(integration, "in-flight-reset");
    await consumeStarted.promise;
    const concurrentResponse = await resetRequest(
      integration,
      "concurrent-reset",
    );

    expect(concurrentResponse.status).toBe(409);
    expect(await concurrentResponse.json()).toEqual({
      error: "reset_in_progress",
    });
    expect(consumedRequests(providerRequests)).toHaveLength(1);
    expect(await consumedRequests(providerRequests)[0]?.clone().json()).toEqual(
      {
        redeem_request_id: "in-flight-reset",
      },
    );

    consumeResult.resolve(Response.json({ code: "reset", windows_reset: 1 }));
    expect((await firstResponse).status).toBe(200);
    closeQuotaSetup(database);
  });

  test("recovers a stale reset with its original provider idempotency key", async () => {
    const setupResult = await connectedQuotaSetup(5, 2);
    const { database, integration, providerRequests } = setupResult;
    new ProviderQuotaStore(database).reserveReset(
      TEST_USER_ID,
      CREDENTIAL_ID,
      "stranded-reset",
      TEST_NOW - 60_000,
    );
    const recovered = await resetRequest(integration, "retry-reset");
    const replay = await resetRequest(integration, "retry-reset");

    await expectResetResult(recovered, false);
    await expectResetResult(replay, true);
    const resetRequests = consumedRequests(providerRequests);
    expect(resetRequests).toHaveLength(1);
    expect(await resetRequests[0]?.clone().json()).toEqual({
      redeem_request_id: "stranded-reset",
    });
    expect(database.select().from(providerQuotaResetReceipts).all()).toEqual([
      expect.objectContaining({
        clientRequestId: "stranded-reset",
        outcome: "reset",
      }),
      expect.objectContaining({
        clientRequestId: "retry-reset",
        outcome: "reset",
      }),
    ]);
    closeQuotaSetup(database);
  });

  test("retains ambiguous failures and retries with the original idempotency key", async () => {
    let attempts = 0;
    const consume = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve(
            Response.json({ code: "already_redeemed", windows_reset: 0 }),
          );
    };
    const connected = await connectedQuotaSetup(5, 2, consume);
    const { database, integration } = connected;

    const failed = await resetRequest(integration, "ambiguous-reset");
    expect(failed.status).toBe(502);
    expectOnlyResetReceipt(database, {
      clientRequestId: "ambiguous-reset",
      isDeleted: false,
      outcome: null,
    });

    const blocked = await resetRequest(integration, "fresh-reset");
    expect(blocked.status).toBe(409);
    database
      .update(providerQuotaResetReceipts)
      .set({ updatedAt: new Date(TEST_NOW - 60_000) })
      .run();

    const recovered = await resetRequest(integration, "fresh-reset");
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      outcome: "already_redeemed",
      replayed: false,
    });
    expect(await consumedRequestBodies(connected.providerRequests)).toEqual([
      { redeem_request_id: "ambiguous-reset" },
      { redeem_request_id: "ambiguous-reset" },
    ]);
    closeQuotaSetup(database);
  });

  test("releases a definitive non-spend outcome for a fresh request", async () => {
    const setupResult = await connectedQuotaSetup(5, 2, () =>
      Promise.resolve(Response.json({ code: "no_credit" })),
    );
    const { database, integration } = setupResult;

    const rejected = await resetRequest(integration, "no-credit-reset");
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({
      outcome: "no_credit",
      replayed: false,
    });
    expectOnlyResetReceipt(database, {
      clientRequestId: "no-credit-reset",
      isDeleted: true,
      outcome: null,
    });

    const retried = await resetRequest(integration, "fresh-reset");
    expect(retried.status).toBe(200);
    expect(await consumedRequestBodies(setupResult.providerRequests)).toEqual([
      { redeem_request_id: "no-credit-reset" },
      { redeem_request_id: "fresh-reset" },
    ]);
    closeQuotaSetup(database);
  });

  test("auto-uses one banked reset at the default one-percent threshold", async () => {
    const { database, integration, providerRequests } =
      await connectedQuotaSetup(1, 1);
    const response = await integration.quota(
      quotaRequest(`${ROUTES.credentialsPath}/${CREDENTIAL_ID}/quota`),
      CREDENTIAL_ID,
    );

    expect(response.status).toBe(200);
    expect(consumedRequests(providerRequests)).toHaveLength(1);
    const resetRequest = consumedRequests(providerRequests)[0];
    expect(resetRequest).toBeDefined();
    const body: unknown = await resetRequest?.clone().json();
    expect(body).toEqual({
      redeem_request_id: `auto-${CREDENTIAL_ID}-${String(TEST_NOW + 9_000_000)}`,
    });
    closeQuotaSetup(database);
  });
});
