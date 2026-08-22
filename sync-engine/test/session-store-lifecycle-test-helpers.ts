import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { agentMessages } from "../../shared/database/schema.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_NOW } from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

type StoreSetup = ReturnType<typeof createStore>;

export function storedAssistantReplays(database: StoreSetup["database"]) {
  const assistantRows = database
    .select({ replay: agentMessages.providerReplay })
    .from(agentMessages)
    .where(eq(agentMessages.role, "assistant"));
  return assistantRows.all();
}

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
