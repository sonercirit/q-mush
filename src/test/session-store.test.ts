import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runners } from "../database/schema.ts";
import { SessionStore } from "../session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000042";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";
const USER_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000044";
const THINKING_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000045";
const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000046";
const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000047";

function createTestSession(store: SessionStore) {
  return store.create(
    {
      credentialId: CREDENTIAL_ID,
      maxContextTokens: 200_000,
      model: "gpt-4.1-mini",
      prompt: "Inspect the repository\nand make it shine",
      provider: "openai",
      reasoningEffort: "high",
      runnerId: RUNNER_ID,
      userId: TEST_USER_ID,
      workingDirectory: "/work/project",
    },
    TEST_NOW,
  );
}

function markTestSessionRunning(store: SessionStore): void {
  expect(store.mark(SESSION_ID, "running", TEST_NOW + 1)).toBeTrue();
}

function testSessionMessageRoles(store: SessionStore) {
  return store.get(TEST_USER_ID, SESSION_ID)?.messages.map(({ role }) => role);
}

function createStore() {
  const database = createAuthenticatedTestDatabase();
  const timestamp = new Date(TEST_NOW);
  database
    .insert(runners)
    .values({
      ...testAuditFields(),
      architecture: "x64",
      id: RUNNER_ID,
      lastSeenAt: timestamp,
      machineFingerprint: "session-store-machine",
      name: "workstation",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("runner-token")
        .digest("base64url"),
      userId: TEST_USER_ID,
    })
    .run();
  addTestProviderCredential(database, CREDENTIAL_ID);
  const ids = [
    SESSION_ID,
    USER_MESSAGE_ID,
    THINKING_MESSAGE_ID,
    ASSISTANT_MESSAGE_ID,
    TOOL_MESSAGE_ID,
  ];
  return {
    database,
    store: new SessionStore(database, () =>
      takeValue(ids, "The test ran out of session IDs"),
    ),
  };
}

describe("session store", () => {
  test("persists a session transcript and lifecycle", () => {
    const { database, store } = createStore();
    const created = createTestSession(store);

    expect(created.agentFile).toBeNull();
    expect(created.id).toBe(SESSION_ID);
    expect(created.status).toBe("queued");
    expect(created.currentContextTokens).toBe(0);
    expect(created.maxContextTokens).toBe(200_000);
    expect(created.reasoningEffort).toBe("high");
    expect(created.title).toBe("Inspect the repository");
    expect(created.messages).toEqual([
      {
        content: "Inspect the repository\nand make it shine",
        createdAt: TEST_NOW,
        id: USER_MESSAGE_ID,
        role: "user",
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
    ]);
    markTestSessionRunning(store);
    store.setAgentFile(
      SESSION_ID,
      { content: "Use Bun for tests.", name: "AGENTS.md" },
      TEST_NOW + 2,
    );

    const thinkingMessage = {
      content: "I should inspect the repository before changing it.",
      role: "thinking" as const,
    };
    const assistantMessage = {
      content: "I will inspect it.",
      role: "assistant" as const,
      toolCalls: [
        {
          arguments: '{"command":"ls"}',
          id: "call-1",
          name: "bash",
        },
      ],
    };
    const toolMessage = {
      content: "README.md",
      role: "tool" as const,
      toolCallId: "call-1",
      toolName: "bash",
    };
    store.appendAgentMessage(SESSION_ID, thinkingMessage, TEST_NOW + 3);
    store.appendAgentMessage(SESSION_ID, assistantMessage, TEST_NOW + 4);
    store.appendAgentMessage(SESSION_ID, toolMessage, TEST_NOW + 5);
    expect(store.mark(SESSION_ID, "idle", TEST_NOW + 6)).toBeTrue();

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(detail?.agentFile).toEqual({
      content: "Use Bun for tests.",
      name: "AGENTS.md",
    });
    expect(detail?.status).toBe("idle");
    expect(detail?.messages.slice(1)).toEqual([
      {
        ...thinkingMessage,
        createdAt: TEST_NOW + 3,
        id: THINKING_MESSAGE_ID,
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
      {
        ...assistantMessage,
        createdAt: TEST_NOW + 4,
        id: ASSISTANT_MESSAGE_ID,
        toolCallId: null,
        toolName: null,
      },
      {
        ...toolMessage,
        createdAt: TEST_NOW + 5,
        id: TOOL_MESSAGE_ID,
        toolCalls: [],
      },
    ]);
    expect(store.list(TEST_USER_ID)).toHaveLength(1);
    database.$client.close();
  });

  test("shows and replays interrupted tool-call results", () => {
    const { database, store } = createStore();
    createTestSession(store);
    markTestSessionRunning(store);
    const interruptedCall = {
      arguments: '{"command":"bun run dev:restart"}',
      id: "interrupted-call",
      name: "bash",
    };
    const assistantMessage = {
      content: "Restarting the server.",
      role: "assistant" as const,
      toolCalls: [interruptedCall],
    };
    store.appendAgentMessage(SESSION_ID, assistantMessage, TEST_NOW + 2);
    expect(testSessionMessageRoles(store)).toEqual(["user", "assistant"]);
    expect(store.mark(SESSION_ID, "failed", TEST_NOW + 3)).toBeTrue();
    expect(testSessionMessageRoles(store)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(
      store.queuePrompt(
        TEST_USER_ID,
        SESSION_ID,
        "Why was it failing?",
        TEST_NOW + 4,
      ).status,
    ).toBe("queued");
    const interruptedToolResult = {
      content:
        "Error: the tool call was interrupted before it returned a result.",
      role: "tool" as const,
      toolCallId: interruptedCall.id,
      toolName: interruptedCall.name,
    };

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(testSessionMessageRoles(store)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(detail?.messages[2]).toEqual({
      ...interruptedToolResult,
      createdAt: TEST_NOW + 2,
      id: `${THINKING_MESSAGE_ID}:interrupted:${interruptedCall.id}`,
      toolCalls: [],
    });
    expect(store.conversation(SESSION_ID)).toEqual([
      {
        content: "Inspect the repository\nand make it shine",
        role: "user",
      },
      assistantMessage,
      interruptedToolResult,
      { content: "Why was it failing?", role: "user" },
    ]);
    database.$client.close();
  });
});
