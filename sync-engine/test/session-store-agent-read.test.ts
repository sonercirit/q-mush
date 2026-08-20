import { describe, expect, test } from "vitest";
import { readSessionSnapshot } from "../session-store-agent-read.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { runningStore } from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

describe("stored session reads", () => {
  test("returns complete persisted source content before the final result bound", () => {
    const { database, store } = runningStore();
    const agentFileContent = `instructions:${"😀".repeat(12_000)}`;
    const messageContent = `result:${"é".repeat(10_000)}`;
    store.setCurrentAgentFile(
      STORE_SESSION_ID,
      { content: agentFileContent, name: "AGENTS.md" },
      TEST_NOW + 2,
    );
    store.appendCurrentAgentMessage(
      STORE_SESSION_ID,
      {
        content: messageContent,
        role: "tool",
        toolCallId: "call-read",
        toolName: "read",
      },
      TEST_NOW + 3,
    );

    const snapshot = readSessionSnapshot(database, {
      includeSystem: true,
      limit: 10,
      roles: ["tool"],
      sessionId: STORE_SESSION_ID,
      userId: TEST_USER_ID,
    });

    expect(snapshot?.agentFile?.content).toBe(agentFileContent);
    expect(snapshot?.transcript.messages.at(-1)?.content).toBe(messageContent);
    database.$client.close();
  });

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
