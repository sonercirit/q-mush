import { expect, test } from "vitest";
import { createdAuditFields } from "../audit.ts";
import { createDatabase } from "../database.ts";
import {
  providerCredentials,
  providerQuotaResetReceipts,
  users,
} from "../database/schema.ts";
import { SYSTEM_ID } from "../ids.ts";
import {
  ProviderQuotaStore,
  type ResetReservation,
} from "../provider-quota-store.ts";
import { hasTestDatabaseTable } from "./database-fixtures.ts";

const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-0000000000a1";
const SETTING_ID = "018bcfe5-6800-7000-8000-0000000000a2";

function audit(actorId = TEST_USER_ID) {
  return createdAuditFields(actorId, TEST_NOW);
}

function setup() {
  const database = createDatabase(":memory:");
  const settingsExist = hasTestDatabaseTable(
    database,
    "provider_quota_settings",
  );
  const receiptsExist = hasTestDatabaseTable(
    database,
    "provider_quota_reset_receipts",
  );
  if (!settingsExist) {
    database.$client.run(`
      CREATE TABLE provider_quota_settings (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
        provider_credential_id text NOT NULL REFERENCES provider_credentials(id) ON DELETE restrict,
        auto_reset_threshold_percent real NOT NULL DEFAULT 1,
        created_at integer NOT NULL,
        created_by_id text NOT NULL,
        updated_at integer NOT NULL,
        updated_by_id text NOT NULL,
        is_deleted integer NOT NULL DEFAULT false
      )
    `);
  }
  if (!receiptsExist) {
    database.$client.run(`
      CREATE TABLE provider_quota_reset_receipts (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE restrict,
        provider_credential_id text NOT NULL REFERENCES provider_credentials(id) ON DELETE restrict,
        client_request_id text NOT NULL,
        outcome text,
        completed_at integer,
        created_at integer NOT NULL,
        created_by_id text NOT NULL,
        updated_at integer NOT NULL,
        updated_by_id text NOT NULL,
        is_deleted integer NOT NULL DEFAULT false
      )
    `);
    database.$client.run(
      "CREATE UNIQUE INDEX provider_quota_reset_receipts_active_request_unique ON provider_quota_reset_receipts(user_id, provider_credential_id, client_request_id) WHERE NOT is_deleted",
    );
    database.$client.run(
      "CREATE UNIQUE INDEX provider_quota_reset_receipts_pending_credential_unique ON provider_quota_reset_receipts(provider_credential_id) WHERE NOT is_deleted AND outcome IS NULL",
    );
  }
  database
    .insert(users)
    .values({
      ...audit(SYSTEM_ID),
      email: "quota@example.test",
      googleSubject: "quota-google",
      id: TEST_USER_ID,
      name: "Quota User",
    })
    .run();
  database
    .insert(providerCredentials)
    .values({
      ...audit(),
      credentialFingerprint: "quota-fingerprint",
      encryptedCredential: "sealed",
      id: CREDENTIAL_ID,
      label: "Quota credential",
      provider: "openai",
      source: "oauth",
      userId: TEST_USER_ID,
    })
    .run();
  const ids = [
    SETTING_ID,
    `${SETTING_ID}-2`,
    `${SETTING_ID}-3`,
    `${SETTING_ID}-4`,
  ];
  return {
    database,
    store: new ProviderQuotaStore(database, () => ids.shift() ?? SETTING_ID),
  };
}

function expectReservation(
  store: ProviderQuotaStore,
  requestId: string,
  expected: ResetReservation,
  now = TEST_NOW,
): void {
  expect(
    store.reserveReset(TEST_USER_ID, CREDENTIAL_ID, requestId, now),
  ).toEqual(expected);
}

function expectReserved(
  store: ProviderQuotaStore,
  requestId: string,
  providerRequestId = requestId,
  now = TEST_NOW,
): void {
  expectReservation(
    store,
    requestId,
    { leaseAcquiredAt: now, providerRequestId, reserved: true },
    now,
  );
}

test("quota reset reservation is atomic and replayable", () => {
  const { database, store } = setup();

  expectReserved(store, "request-1");
  expectReservation(store, "request-1", { reserved: false });
  expectReservation(store, "request-2", { reserved: false });

  store.completeReset(
    TEST_USER_ID,
    CREDENTIAL_ID,
    "request-1",
    "reset",
    TEST_NOW,
    "request-1",
    TEST_NOW,
  );
  expectReservation(store, "request-1", {
    replayedResult: "reset",
    reserved: false,
  });
  expectReserved(store, "request-2");
  store.releaseReset(
    TEST_USER_ID,
    CREDENTIAL_ID,
    "request-2",
    TEST_NOW,
    TEST_NOW,
  );
  expectReserved(store, "request-3");

  expect(
    database.$client
      .query<{ readonly count: number }, []>(
        "SELECT count(*) AS count FROM provider_quota_reset_receipts",
      )
      .get()?.count,
  ).toBe(3);
  database.$client.close();
});

test("a stale reset worker cannot complete or publish a replay receipt", () => {
  const { database, store } = setup();
  const secondLeaseAt = TEST_NOW + 60_000;
  const thirdLeaseAt = secondLeaseAt + 60_000;

  expectReserved(store, "request-1");
  expectReserved(store, "request-2", "request-1", secondLeaseAt);
  expectReserved(store, "request-3", "request-1", thirdLeaseAt);

  store.completeReset(
    TEST_USER_ID,
    CREDENTIAL_ID,
    "request-1",
    "reset",
    thirdLeaseAt,
    "request-2",
    secondLeaseAt,
  );

  expect(
    database.select().from(providerQuotaResetReceipts).all(),
  ).toMatchObject([
    {
      clientRequestId: "request-1",
      outcome: null,
      updatedAt: new Date(thirdLeaseAt),
    },
  ]);
  expectReservation(store, "request-2", { reserved: false }, thirdLeaseAt);

  store.completeReset(
    TEST_USER_ID,
    CREDENTIAL_ID,
    "request-1",
    "already_redeemed",
    thirdLeaseAt,
    "request-3",
    thirdLeaseAt,
  );
  expectReservation(store, "request-3", {
    replayedResult: "already_redeemed",
    reserved: false,
  });

  database.$client.close();
});

test("stale quota reset reservations resume under their provider idempotency key", () => {
  const { database, store } = setup();
  const recoveredAt = TEST_NOW + 60_000;

  expectReserved(store, "request-1");
  expectReservation(store, "request-2", { reserved: false }, recoveredAt - 1);
  expectReserved(store, "request-2", "request-1", recoveredAt);
  expectReservation(store, "request-3", { reserved: false }, recoveredAt);

  store.completeReset(
    TEST_USER_ID,
    CREDENTIAL_ID,
    "request-1",
    "already_redeemed",
    recoveredAt,
    "request-2",
    recoveredAt,
  );
  expectReservation(store, "request-1", {
    replayedResult: "already_redeemed",
    reserved: false,
  });
  expectReservation(store, "request-2", {
    replayedResult: "already_redeemed",
    reserved: false,
  });
  expectReserved(store, "request-3");

  database.$client.close();
});
