import { expect } from "vitest";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

type StoreSetup = ReturnType<typeof createStore>;

export function markTestSessionRunning(store: SessionStore): void {
  expect(
    store.transitionCurrent(STORE_SESSION_ID, "running", TEST_NOW + 1),
  ).toBe(true);
}

export function runningStore(): StoreSetup {
  const setup = createStore();
  createTestSession(setup.store);
  markTestSessionRunning(setup.store);
  return setup;
}
