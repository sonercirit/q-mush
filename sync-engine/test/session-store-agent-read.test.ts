import { describe, expect, test } from "vitest";
import { readSessionSnapshot } from "../session-store-agent-read.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

describe("stored session reads", () => {
  test("returns persisted error notices when the error category is selected", () => {
    const { database, store } = runningStore();
    // Truncation and failure notices persist as error rows; the database
    // filter must return them when selected, not only the formatter.
    store.appendRuntimeErrorMessage(
      STORE_SESSION_ID,
      "The response was truncated: it reached the maximum output tokens.",
      TEST_NOW + 2,
      0,
    );

    const snapshot = readSessionSnapshot(database, {
      includeSystem: false,
      limit: 10,
      roles: ["assistant", "error"],
      sessionId: STORE_SESSION_ID,
      userId: TEST_USER_ID,
    });

    expect(
      snapshot?.transcript.messages.map(({ content, role }) => ({
        content,
        role,
      })),
    ).toContainEqual({
      content:
        "The response was truncated: it reached the maximum output tokens.",
      role: "error",
    });
    database.$client.close();
  });
});
