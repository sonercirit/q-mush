import { test } from "vitest";
import { expectSessionContextTokenCapLifecycle } from "./session-context-limit-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

test("applies and clears an effective context token cap", () => {
  const { database, store } = createStore();
  createTestSession(store);
  expectSessionContextTokenCapLifecycle(store);
  database.$client.close();
});
