import { expect } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

export type CompactionStoreSetup = ReturnType<typeof createStore>;

export function runningCompactionStore(): CompactionStoreSetup {
  const setup = createStore();
  createTestSession(setup.store);
  expect(
    setup.store.transitionCurrent(STORE_SESSION_ID, "running", TEST_NOW + 1),
  ).toBe(true);
  return setup;
}

export function requireCompactionSession(
  store: SessionStore,
): AgentSessionDetail {
  const session = store.get(TEST_USER_ID, STORE_SESSION_ID);
  if (session === undefined) {
    throw new Error("The compaction test session is unavailable");
  }
  return session;
}
