import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { createDatabase } from "../../shared/database.ts";
import {
  providerCredentials,
  providerLimitObservations,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { ProviderLimitObservation } from "../../shared/provider-limits.ts";
import { ProviderLimitStore } from "../../sync-engine/provider-limit-store.ts";

const USER_ID = "018bcfe5-6800-7000-8000-000000000081";
const OTHER_USER_ID = "018bcfe5-6800-7000-8000-000000000082";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000083";
const OPENROUTER_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000084";
const NOW = 1_700_000_000_000;

function requestDimension(): ProviderLimitObservation["dimensions"][number] {
  return {
    key: "requests",
    label: "Requests",
    limit: 100,
    remaining: 50,
    resetAt: NOW + 60_000,
    unit: "requests",
  };
}

function unsafeDimension(
  dimension: ProviderLimitObservation["dimensions"][number],
): ProviderLimitObservation["dimensions"][number] {
  return Object.assign({}, dimension, {
    payload: { account_id: "provider-account", token: "secret" },
    rawHeader: "Bearer secret",
  });
}

function observation(
  observedAt: number,
  dimensions: ProviderLimitObservation["dimensions"] = [requestDimension()],
): ProviderLimitObservation {
  return {
    dimensions,
    observedAt,
    provider: "openai",
    source: "http_headers",
  };
}

function observe(
  store: ProviderLimitStore,
  value: ProviderLimitObservation,
  credentialId = CREDENTIAL_ID,
  receivedAt = value.observedAt,
): boolean {
  return store.observe({ credentialId, userId: USER_ID }, value, receivedAt);
}

function unavailable(store: ProviderLimitStore, credentialId = CREDENTIAL_ID) {
  return store.read(USER_ID, credentialId, NOW).status === "unavailable";
}

function finish(database: ReturnType<typeof createDatabase>): void {
  database.$client.close();
}

function expectUnavailable(store: ProviderLimitStore, credentialId?: string) {
  expect(unavailable(store, credentialId)).toBe(true);
}

function setup() {
  const database = createDatabase(":memory:");
  for (const [id, subject] of [
    [USER_ID, "google-user"],
    [OTHER_USER_ID, "google-other"],
  ] as const) {
    database
      .insert(users)
      .values({
        ...createdAuditFields(SYSTEM_ID, NOW),
        email: `${subject}@example.com`,
        googleSubject: subject,
        id,
        name: subject,
      })
      .run();
  }
  database
    .insert(providerCredentials)
    .values([
      {
        ...createdAuditFields(USER_ID, NOW),
        credentialFingerprint: "fingerprint",
        encryptedCredential: "encrypted",
        id: CREDENTIAL_ID,
        isDefault: false,
        label: "Work key",
        provider: "openai",
        source: "api_key",
        userId: USER_ID,
      },
      {
        ...createdAuditFields(USER_ID, NOW),
        credentialFingerprint: "openrouter-fingerprint",
        encryptedCredential: "encrypted",
        id: OPENROUTER_CREDENTIAL_ID,
        isDefault: false,
        label: "Gateway key",
        provider: "openrouter",
        source: "api_key",
        userId: USER_ID,
      },
    ])
    .run();
  return { database, store: new ProviderLimitStore(database) };
}

describe("provider limit store", () => {
  test("scopes observations to the credential owner and marks age-derived stale state", () => {
    const { database, store } = setup();
    const accepted = observe(store, observation(NOW));
    expect(accepted).toBe(true);
    const otherUsersLimits = store.read(OTHER_USER_ID, CREDENTIAL_ID, NOW);
    expect(otherUsersLimits.status).toBe("unavailable");
    expect(store.read(USER_ID, CREDENTIAL_ID, NOW)).toMatchObject({
      observedAt: NOW,
      stale: false,
      status: "available",
    });
    expect(
      store.read(USER_ID, CREDENTIAL_ID, NOW + 15 * 60_000 + 1),
    ).toMatchObject({ stale: true, status: "available" });
    finish(database);
  });

  test("rejects observations whose provider does not match the credential", () => {
    const setupResult = setup();
    const mismatched = observe(
      setupResult.store,
      observation(NOW),
      OPENROUTER_CREDENTIAL_ID,
    );

    expect(mismatched).toBe(false);
    expectUnavailable(setupResult.store, OPENROUTER_CREDENTIAL_ID);
    finish(setupResult.database);
  });

  test("keeps prior dimensions after partial retry evidence", () => {
    const { database, store } = setup();
    observe(
      store,
      observation(NOW, [
        {
          key: "requests",
          label: "Requests",
          limit: 100,
          remaining: 50,
          resetAt: null,
          unit: "requests",
        },
        {
          key: "tokens",
          label: "Tokens",
          limit: 1_000,
          remaining: 800,
          resetAt: null,
          unit: "tokens",
        },
      ]),
    );
    observe(
      store,
      observation(NOW + 1, [
        {
          key: "requests",
          label: "Requests",
          limit: null,
          remaining: null,
          resetAt: NOW + 10_000,
          unit: "requests",
        },
      ]),
      undefined,
      NOW + 1,
    );

    expect(store.read(USER_ID, CREDENTIAL_ID, NOW + 1)).toMatchObject({
      dimensions: [
        {
          key: "requests",
          limit: 100,
          remaining: 50,
          resetAt: NOW + 10_000,
        },
        { key: "tokens", limit: 1_000, remaining: 800 },
      ],
    });
    finish(database);
  });

  test("deterministically rejects older concurrent observations", () => {
    const setupResult = setup();
    const database = setupResult.database;
    const store = setupResult.store;
    const newestAccepted = observe(store, observation(NOW + 2));
    expect(newestAccepted).toBe(true);
    expect(observe(store, observation(NOW))).toBe(false);
    expect(store.read(USER_ID, CREDENTIAL_ID, NOW + 2)).toMatchObject({
      observedAt: NOW + 2,
    });
    expect(observe(store, observation(NOW + 2), undefined, NOW + 3)).toBe(true);
    expect(store.read(USER_ID, CREDENTIAL_ID, NOW + 3)).toMatchObject({
      observedAt: NOW + 2,
    });
    finish(database);
  });

  test("rejects malformed observations before persistence", () => {
    const { database, store } = setup();
    const malformed = {
      ...observation(NOW),
      dimensions: [
        {
          ...requestDimension(),
          remaining: Number.POSITIVE_INFINITY,
        },
      ],
    };
    const duplicate = observation(NOW, [
      requestDimension(),
      requestDimension(),
    ]);

    expect(observe(store, malformed)).toBe(false);
    expect(observe(store, duplicate)).toBe(false);
    expectUnavailable(store);
    finish(database);
  });

  test("persists only decoded safe metadata", () => {
    const { database, store } = setup();
    const unsafe: ProviderLimitObservation = {
      ...observation(NOW),
      dimensions: [unsafeDimension(requestDimension())],
    };

    expect(observe(store, unsafe)).toBe(true);
    const stored = database
      .select({ dimensions: providerLimitObservations.dimensions })
      .from(providerLimitObservations)
      .get();
    expect(stored).toBeDefined();
    expect(JSON.parse(stored?.dimensions ?? "null")).toEqual([
      requestDimension(),
    ]);
    expect(stored?.dimensions).not.toContain("secret");
    expect(stored?.dimensions).not.toContain("account");
    finish(database);
  });

  test("treats malformed stored dimensions as unavailable", () => {
    const { database, store } = setup();
    expect(observe(store, observation(NOW))).toBe(true);
    database
      .update(providerLimitObservations)
      .set({ dimensions: '{"rawHeader":"secret"}' })
      .run();

    expectUnavailable(store);
    finish(database);
  });

  test("soft deletion hides saved limit metadata", () => {
    const setupResult = setup();
    observe(setupResult.store, observation(NOW));
    setupResult.database
      .update(providerCredentials)
      .set({ isDeleted: true, updatedAt: new Date(NOW + 1) })
      .run();

    expect(unavailable(setupResult.store)).toBe(true);
    expect(setupResult.store.list(USER_ID, NOW)).toHaveLength(0);
    finish(setupResult.database);
  });
});
