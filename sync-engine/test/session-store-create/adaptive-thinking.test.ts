import { expect, test } from "vitest";
import { agentSessions } from "../../../shared/database/schema.ts";
import { TEST_NOW } from "../authenticated-integration-test-helpers.ts";
import {
  createStore,
  testSessionInput,
} from "../session-store-test-fixtures.ts";

test("rejects an invalid adaptive-thinking capability", () => {
  const { database, store } = createStore();

  const input = testSessionInput();
  Object.defineProperty(input, "adaptiveThinking", { value: "unsupported" });
  expect(() => store.create(input, TEST_NOW)).toThrow(
    "adaptive-thinking capability is invalid",
  );

  expect(database.select().from(agentSessions).all()).toHaveLength(0);
  database.$client.close();
});
