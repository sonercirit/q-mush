import { test } from "vitest";
import { expectSessionContextTokenCapLifecycle } from "./session-context-limit-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

test("applies and clears an effective context token cap", () => {
  const fixture = createStore();
  createTestSession(fixture.store);
  expectSessionContextTokenCapLifecycle(fixture.store);
  fixture.database.$client.close();
});
