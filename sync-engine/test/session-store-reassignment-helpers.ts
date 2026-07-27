import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { runners, users } from "../../shared/database/schema.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { expectRunnerRequired } from "./session-integration-helpers.ts";

export interface SessionStoreTestSetup {
  readonly database: AppDatabase;
  readonly store: SessionStore;
}

const FOREIGN_USER_ID = "018bcfe5-6800-7000-8000-000000000098";

export function addForeignReplacementRunner(
  database: AppDatabase,
  replacementId: string,
): void {
  database
    .insert(users)
    .values({
      ...testAuditFields(FOREIGN_USER_ID),
      email: "foreign-runner@example.com",
      googleSubject: "foreign-runner-user",
      id: FOREIGN_USER_ID,
      name: "Foreign Runner User",
    })
    .run();
  addReplacementRunner(database, replacementId, FOREIGN_USER_ID);
}

export function addReplacementRunner(
  database: AppDatabase,
  replacementId: string,
  userId = TEST_USER_ID,
): void {
  database
    .insert(runners)
    .values({
      ...testAuditFields(userId),
      architecture: "arm64",
      id: replacementId,
      lastSeenAt: new Date(TEST_NOW + 3),
      machineFingerprint: `replacement-machine-${replacementId}`,
      name: "replacement",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update(`replacement-token-${replacementId}`)
        .digest("base64url"),
      userId,
    })
    .run();
}

export function closeSessionStoreTestSetup(setup: SessionStoreTestSetup): void {
  setup.database.$client.close();
}

export function removeTestRunner(
  setup: SessionStoreTestSetup,
  runnerId: string,
  now = TEST_NOW + 2,
): boolean {
  return new RunnerStore(setup.database).remove(TEST_USER_ID, runnerId, now);
}

export function removeTestRunnerAndExpect(
  setup: SessionStoreTestSetup,
  runnerId: string,
  now = TEST_NOW + 2,
): void {
  expect(removeTestRunner(setup, runnerId, now)).toBe(true);
}

export function expectStoredSession(
  store: SessionStore,
  sessionId: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  expect(store.get(TEST_USER_ID, sessionId)).toMatchObject(expected);
}

export function removeAndReadSession(
  setup: SessionStoreTestSetup,
  runnerId: string,
  sessionId: string,
) {
  removeTestRunnerAndExpect(setup, runnerId);
  return setup.store.get(TEST_USER_ID, sessionId);
}

export function expectRecoveredSession(
  database: AppDatabase,
  before: ReturnType<SessionStore["get"]>,
  sessionId: string,
): void {
  const restarted = new SessionStore(database);
  expect(restarted.failInterrupted(TEST_NOW + 3)).toEqual([]);
  expect(restarted.get(TEST_USER_ID, sessionId)).toEqual(before);
  expectRunnerRequired(restarted.get(TEST_USER_ID, sessionId));
}
