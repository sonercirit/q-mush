import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { runners } from "../../shared/database/schema.ts";
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

export function addReplacementRunner(
  database: AppDatabase,
  replacementId: string,
): void {
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "arm64",
      id: replacementId,
      lastSeenAt: new Date(TEST_NOW + 3),
      machineFingerprint: "replacement-machine",
      name: "replacement",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("replacement-token")
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
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
