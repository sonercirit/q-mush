import { describe, expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import {
  ASSISTANT_MESSAGE_ID,
  createStore,
  createTestSession,
  markTestSessionRunning,
  runningStore,
  SESSION_ID,
  testSessionInput,
  THINKING_MESSAGE_ID,
  TOOL_MESSAGE_ID,
  USER_MESSAGE_ID,
} from "./session-store-fixtures.ts";

function testUserImageMessage(
  id: string,
  content: string,
): AgentSessionMessage {
  const baseMessage = {
    content,
    createdAt: 2,
    id,
  };
  const toolFields = {
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  } as const;
  return {
    ...baseMessage,
    ...toolFields,
    images: [TEST_AGENT_IMAGE],
    role: "user",
  };
}

function completedChildWithParent(
  store: SessionStore,
  parentSessionId: string,
) {
  const child = store.create(
    { ...testSessionInput(), parentSessionId },
    TEST_NOW + 1,
  );
  expect(store.mark(child.id, "running", TEST_NOW + 2)).toBe(true);
  expect(store.mark(child.id, "idle", TEST_NOW + 3)).toBe(true);
  return child;
}

function testSessionMessageRoles(store: SessionStore) {
  return store.get(TEST_USER_ID, SESSION_ID)?.messages.map(({ role }) => role);
}

function expectedTranscriptRoles(
  includeError: boolean,
  includeFollowUp = false,
): readonly string[] {
  return [
    "user",
    "assistant",
    ...(includeError ? ["error"] : []),
    "tool",
    ...(includeFollowUp ? ["user"] : []),
  ];
}

function initialConversation() {
  return [
    {
      content: "Inspect the repository\nand make it shine",
      images: [TEST_AGENT_IMAGE],
      role: "user" as const,
    },
  ];
}

describe("session store", () => {
  test("persists a session transcript and lifecycle", () => {
    const { database, store } = createStore();
    const created = createTestSession(store);

    expect(created.agentFile).toBeNull();
    expect(created.id).toBe(SESSION_ID);
    expect(created.status).toBe("queued");
    expect(created.activeDurationMs).toBe(0);
    expect(created.activeStartedAt).toBeNull();
    expect(created.costBasis).toBe("none");
    expect(created.costUsd).toBe(0);
    expect(created.currentContextTokens).toBe(0);
    expect(created.autoCompact).toBe(true);
    expect(created.maxContextTokens).toBe(200_000);
    expect(created.reasoningEffort).toBe("high");
    expect(created.tools).toEqual(AGENT_SESSION_TOOL_NAMES);
    expect(created.title).toBe("Inspect the repository");
    expect(created.messages).toEqual([
      {
        ...testUserImageMessage(
          USER_MESSAGE_ID,
          "Inspect the repository\nand make it shine",
        ),
        createdAt: TEST_NOW,
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
    store.updateUsage(
      SESSION_ID,
      { contextTokens: 1_000, costBasis: "reported", costUsd: 0.1 },
      TEST_NOW + 5,
    );
    store.updateUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "estimated", costUsd: 0.05 },
      TEST_NOW + 5,
    );
    expect(store.mark(SESSION_ID, "idle", TEST_NOW + 6)).toBe(true);

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(detail?.agentFile).toEqual({
      content: "Use Bun for tests.",
      name: "AGENTS.md",
    });
    expect(detail?.status).toBe("idle");
    expect(detail?.activeDurationMs).toBe(5);
    expect(detail?.activeStartedAt).toBeNull();
    expect(detail?.costBasis).toBe("estimated");
    expect(detail?.costUsd).toBeCloseTo(0.15);
    expect(detail?.currentContextTokens).toBe(1_000);
    expect(detail?.messages.slice(1)).toEqual([
      {
        ...thinkingMessage,
        createdAt: TEST_NOW + 3,
        id: THINKING_MESSAGE_ID,
        images: [],
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
      {
        ...assistantMessage,
        createdAt: TEST_NOW + 4,
        id: ASSISTANT_MESSAGE_ID,
        images: [],
        toolCallId: null,
        toolName: null,
      },
      {
        ...toolMessage,
        createdAt: TEST_NOW + 5,
        id: TOOL_MESSAGE_ID,
        images: [],
        toolCalls: [],
      },
    ]);
    expect(store.list(TEST_USER_ID)).toHaveLength(1);
    database.$client.close();
  });

  test("orders equal-timestamp transcript records by message id", () => {
    const { database, store } = runningStore();
    const timestamp = new Date(TEST_NOW + 2);
    const common = {
      ...testAuditFields(SYSTEM_ID),
      content: "same timestamp",
      createdAt: timestamp,
      sessionId: SESSION_ID,
      updatedAt: timestamp,
      userId: TEST_USER_ID,
    };
    database
      .insert(agentMessages)
      .values([
        { ...common, id: "message-z", role: "assistant" },
        { ...common, id: "message-a", role: "thinking" },
        { ...common, id: "message-m", role: "assistant" },
      ])
      .run();

    expect(
      store
        .get(TEST_USER_ID, SESSION_ID)
        ?.messages.filter(({ createdAt }) => createdAt === TEST_NOW + 2)
        .map(({ id }) => id),
    ).toEqual(["message-a", "message-m", "message-z"]);
    database.$client.close();
  });

  test("keeps an estimated cost basis after a provider-reported charge", () => {
    const { database, store } = runningStore();

    store.updateUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "estimated", costUsd: 0.02 },
      TEST_NOW + 2,
    );
    store.updateUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "reported", costUsd: 0.03 },
      TEST_NOW + 3,
    );
    expect(() => {
      store.updateUsage(
        SESSION_ID,
        { contextTokens: null, costBasis: null, costUsd: 0.01 },
        TEST_NOW + 4,
      );
    }).toThrow("usage is invalid");

    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      costBasis: "estimated",
      costUsd: 0.05,
    });
    database.$client.close();
  });

  test("persists a session's selected tools", () => {
    const { database, store } = createStore();
    const tools: readonly AgentSessionToolName[] = ["read", "brave_search"];

    const detail = store.create({ ...testSessionInput(), tools }, TEST_NOW);

    expect(detail.tools).toEqual(tools);
    expect(store.list(TEST_USER_ID)[0]?.tools).toEqual(tools);
    database.$client.close();
  });

  test("persists and claims a spawned session's parent callback", () => {
    const { database, store } = createStore();
    const parent = createTestSession(store);
    const child = completedChildWithParent(store, parent.id);

    expect(store.pendingSpawnedSessions()).toEqual([
      { detail: store.get(TEST_USER_ID, child.id), userId: TEST_USER_ID },
    ]);
    expect(store.parentSessionId(TEST_USER_ID, child.id)).toBe(parent.id);
    expect(
      store.appendSpawnedSessionReport(
        TEST_USER_ID,
        child.id,
        parent.id,
        "Child complete",
        TEST_NOW + 4,
      ),
    ).toBe(true);
    expect(store.parentSessionId(TEST_USER_ID, child.id)).toBeUndefined();
    expect(store.pendingSpawnedSessions()).toEqual([]);
    expect(store.get(TEST_USER_ID, parent.id)?.messages.at(-1)?.content).toBe(
      "Child complete",
    );
    database.$client.close();
  });

  test("does not claim a child callback when its parent is missing", () => {
    const { database, store } = createStore();
    const child = completedChildWithParent(store, "missing-parent");

    expect(
      store.appendSpawnedSessionReport(
        TEST_USER_ID,
        child.id,
        "missing-parent",
        "Child complete",
        TEST_NOW + 3,
      ),
    ).toBe(false);
    expect(store.parentSessionId(TEST_USER_ID, child.id)).toBe(
      "missing-parent",
    );
    database.$client.close();
  });

  test("uses a fallback title for an image-only task", () => {
    const { database, store } = createStore();
    const detail = store.create(
      {
        ...testSessionInput(),
        maxContextTokens: null,
        prompt: "",
        reasoningEffort: null,
      },
      TEST_NOW,
    );

    expect(detail.title).toBe("Image task");
    database.$client.close();
  });

  test("compacts stored work into a replayable handoff", () => {
    const { database, store } = createStore();
    const session = createTestSession(store);
    expect(session.status).toBe("queued");
    markTestSessionRunning(store);
    store.appendAgentMessage(
      SESSION_ID,
      { content: "Work in progress.", role: "assistant", toolCalls: [] },
      TEST_NOW + 2,
    );

    store.compact(
      SESSION_ID,
      "Keep the completed work and run tests.",
      TEST_NOW + 3,
    );

    expect(store.conversation(SESSION_ID)).toEqual([
      {
        content:
          "Conversation compacted:\n\nKeep the completed work and run tests.",
        role: "user",
      },
    ]);
    expect(store.get(TEST_USER_ID, SESSION_ID)?.currentContextTokens).toBe(0);
    database.$client.close();
  });

  test("continues without appending a user message", () => {
    const setup = runningStore();
    expect(setup.store.mark(SESSION_ID, "idle", TEST_NOW + 2)).toBe(true);
    const before = setup.store.conversation(SESSION_ID);

    const queued = setup.store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 3);

    expect(queued.status).toBe("queued");
    expect(setup.store.conversation(SESSION_ID)).toEqual(before);
    expect(setup.store.get(TEST_USER_ID, SESSION_ID)?.status).toBe("queued");
    setup.database.$client.close();
  });

  test("records an error when an active session is interrupted", () => {
    const { database, store } = runningStore();

    store.failInterrupted(TEST_NOW + 2);

    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      activeDurationMs: 1,
      activeStartedAt: null,
      messages: [
        { role: "user" },
        {
          content:
            "Session failed: the server stopped before the session completed",
          role: "error",
        },
      ],
      status: "failed",
    });
    database.$client.close();
  });

  test("fills missing tool results when replaying a transcript", () => {
    const { database, store } = runningStore();
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
    store.appendErrorMessage(SESSION_ID, "Session failed", TEST_NOW + 3);
    expect(store.mark(SESSION_ID, "failed", TEST_NOW + 4)).toBe(true);
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      activeDurationMs: 3,
      activeStartedAt: null,
      status: "failed",
    });
    expect(testSessionMessageRoles(store)).toEqual(
      expectedTranscriptRoles(true),
    );
    expect(
      store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 5, {
        content: "Why was it failing?",
        images: [],
      }).status,
    ).toBe("queued");
    const interruptedToolResult = {
      content:
        "Error: the tool call was interrupted before it returned a result.",
      role: "tool" as const,
      toolCallId: interruptedCall.id,
      toolName: interruptedCall.name,
    };

    const detail = store.get(TEST_USER_ID, SESSION_ID);
    expect(testSessionMessageRoles(store)).toEqual(
      expectedTranscriptRoles(true, true),
    );
    expect(detail?.messages[3]).toEqual({
      ...interruptedToolResult,
      createdAt: TEST_NOW + 2,
      id: `${THINKING_MESSAGE_ID}:interrupted:${interruptedCall.id}`,
      images: [],
      toolCalls: [],
    });
    expect(store.conversation(SESSION_ID)).toEqual([
      ...initialConversation(),
      assistantMessage,
      interruptedToolResult,
      { content: "Why was it failing?", role: "user" },
    ]);
    database.$client.close();
  });
});
