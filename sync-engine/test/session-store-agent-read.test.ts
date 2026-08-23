import { describe, expect, test } from "vitest";
import { readSessionSnapshot } from "../session-store-agent-read.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { privateReplay } from "./private-replay-fixtures.ts";
import {
  runningStore,
  storedAssistantReplays,
} from "./session-store-lifecycle-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

function snapshot(options: {
  readonly includeSystem: boolean;
  readonly roles: readonly ("assistant" | "error" | "tool")[];
}) {
  const setup = runningStore();
  return {
    ...setup,
    read: () =>
      readSessionSnapshot(setup.database, {
        includeSystem: options.includeSystem,
        limit: 10,
        roles: options.roles,
        sessionId: STORE_SESSION_ID,
        userId: TEST_USER_ID,
      }),
  };
}

describe("stored session reads", () => {
  test("never selects private provider replay for read_session", () => {
    const { database, read, store } = snapshot({
      includeSystem: false,
      roles: ["assistant"],
    });
    store.appendCurrentAgentMessage(
      STORE_SESSION_ID,
      {
        content: "Visible answer",
        providerReplay: privateReplay(
          "read-session-private-signature",
          "Visible answer",
        ),
        role: "assistant",
        toolCalls: [],
      },
      TEST_NOW + 2,
    );

    const session = read();

    expect(JSON.stringify(session)).toContain("Visible answer");
    expect(JSON.stringify(session)).not.toContain(
      "read-session-private-signature",
    );
    const stored = storedAssistantReplays(database);
    expect(stored[0]?.replay).toContain("read-session-private-signature");
    database.$client.close();
  });

  test("returns complete persisted source content before the final result bound", () => {
    const { database, read, store } = snapshot({
      includeSystem: true,
      roles: ["tool"],
    });
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

    const session = read();

    expect(session?.agentFile?.content).toBe(agentFileContent);
    expect(session?.transcript.messages.at(-1)?.content).toBe(messageContent);
    database.$client.close();
  });

  test("returns persisted error notices when the error category is selected", () => {
    const errorSetup = snapshot({
      includeSystem: false,
      roles: ["assistant", "error"],
    });
    const { database, read, store } = errorSetup;
    // Truncation and failure notices persist as error rows; the database
    // filter must return them when selected, not only the formatter.
    store.appendRuntimeErrorMessage(
      STORE_SESSION_ID,
      "The response was truncated: it reached the maximum output tokens.",
      TEST_NOW + 2,
      0,
    );

    const session = read();

    expect(
      session?.transcript.messages.map(({ content, role }) => ({
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
