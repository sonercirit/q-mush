import { describe, expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { createRunnerStore } from "../../sync-engine/runner-store.ts";
import type { SessionStore } from "../../sync-engine/session-store.ts";
import { endGenerationSessionTurn } from "../../sync-engine/session-turn-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { testCompactionHandoffMessage } from "./compaction-test-fixtures.ts";
import {
  ASSISTANT_MESSAGE_ID,
  RUNNER_ID,
  SESSION_ID,
  THINKING_MESSAGE_ID,
  TOOL_MESSAGE_ID,
  USER_MESSAGE_ID,
} from "./session-store-ids.ts";
import {
  markTestSessionRunning,
  runningStore,
} from "./session-store-lifecycle-test-helpers.ts";
import {
  closeSessionStoreTestSetup,
  expectRecoveredSession,
  expectStoredSession,
  removeAndReadSession,
  removeTestRunnerAndExpect,
} from "./session-store-reassignment-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";
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

function testSessionMessageRoles(store: SessionStore) {
  return store.get(TEST_USER_ID, SESSION_ID)?.messages.map(({ role }) => role);
}

function expectPersistedTurns(
  actual: AgentSessionDetail["turns"],
  firstBoundaryMessageId: string | undefined,
  last: Readonly<{
    readonly endedAt: number | null;
    readonly startedAt: number;
  }>,
): void {
  expect(actual).toEqual([
    expect.objectContaining({
      boundaryMessageId: firstBoundaryMessageId,
      endedAt: TEST_NOW + 3,
      startedAt: TEST_NOW,
    }),
    expect.objectContaining(last),
  ]);
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
    const created = createTestSession(store, TEST_NOW, {
      agentFilePath: "config/instructions.md",
    });

    expect(created.agentFilePath).toBe("config/instructions.md");
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
    expect(created.adaptiveThinking).toBe(false);
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
        turnId: USER_MESSAGE_ID,
      },
    ]);
    markTestSessionRunning(store);
    store.setCurrentAgentFile(
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
    store.appendCurrentAgentMessage(SESSION_ID, thinkingMessage, TEST_NOW + 3);
    store.appendCurrentAgentMessage(SESSION_ID, assistantMessage, TEST_NOW + 4);
    store.appendCurrentAgentMessage(SESSION_ID, toolMessage, TEST_NOW + 5);
    store.updateCurrentUsage(
      SESSION_ID,
      { contextTokens: 1_000, costBasis: "reported", costUsd: 0.1 },
      TEST_NOW + 5,
    );
    store.updateCurrentUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "estimated", costUsd: 0.05 },
      TEST_NOW + 5,
    );
    expect(store.transitionCurrent(SESSION_ID, "idle", TEST_NOW + 6)).toBe(
      true,
    );

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
    expect(detail?.turns).toEqual([
      {
        boundaryMessageId: TOOL_MESSAGE_ID,
        endedAt: TEST_NOW + 6,
        executionGeneration: 0,
        id: USER_MESSAGE_ID,
        startedAt: TEST_NOW,
        toolSettings: DEFAULT_TOOL_SETTINGS,
      },
    ]);
    expect(detail?.messages.slice(1)).toEqual([
      {
        ...thinkingMessage,
        createdAt: TEST_NOW + 3,
        id: THINKING_MESSAGE_ID,
        images: [],
        toolCallId: null,
        toolCalls: [],
        toolName: null,
        turnId: USER_MESSAGE_ID,
      },
      {
        ...assistantMessage,
        createdAt: TEST_NOW + 4,
        id: ASSISTANT_MESSAGE_ID,
        images: [],
        toolCallId: null,
        toolName: null,
        turnId: USER_MESSAGE_ID,
      },
      {
        ...toolMessage,
        createdAt: TEST_NOW + 5,
        id: TOOL_MESSAGE_ID,
        images: [],
        toolCalls: [],
        turnId: USER_MESSAGE_ID,
      },
    ]);

    expect(store.list(TEST_USER_ID)).toHaveLength(1);
    database.$client.close();
  });

  test("ending an already-ended turn is a no-op", () => {
    const setup = runningStore();
    const settledNow = TEST_NOW + 3;
    const didSettle = setup.store.transitionCurrent(
      SESSION_ID,
      "idle",
      settledNow,
    );
    expect(didSettle).toBe(true);
    const settled = setup.store.get(TEST_USER_ID, SESSION_ID)?.turns;

    endGenerationSessionTurn(setup.database, SESSION_ID, 0, TEST_NOW + 100);

    expect(setup.store.get(TEST_USER_ID, SESSION_ID)?.turns).toEqual(settled);
    setup.database.$client.close();
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

    store.updateCurrentUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "estimated", costUsd: 0.02 },
      TEST_NOW + 2,
    );
    store.updateCurrentUsage(
      SESSION_ID,
      { contextTokens: null, costBasis: "reported", costUsd: 0.03 },
      TEST_NOW + 3,
    );
    expect(() => {
      store.updateCurrentUsage(
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

  test("rolls back every model message when usage persistence fails", () => {
    const { database, store } = runningStore();
    const before = store.get(TEST_USER_ID, SESSION_ID);
    database.$client.run(`
      CREATE TRIGGER reject_model_usage
      BEFORE UPDATE OF cost_usd ON agent_sessions
      WHEN NEW.cost_usd > OLD.cost_usd
      BEGIN
        SELECT RAISE(ABORT, 'model usage persistence failed');
      END
    `);

    expect(() => {
      store.appendRuntimeAgentMessages(
        SESSION_ID,
        [
          {
            content: "Usage-failing model reasoning",
            role: "thinking",
          },
          {
            content: "Usage-failing model step",
            role: "assistant",
            toolCalls: [],
          },
        ],
        TEST_NOW + 4,
        0,
        { contextTokens: 1_000, costBasis: "reported", costUsd: 0.1 },
      );
    }).toThrow("model usage persistence failed");

    expect(store.get(TEST_USER_ID, SESSION_ID)).toEqual(before);
    database.$client.close();
  });

  test("persists a session's selected tools", () => {
    const { database, store } = createStore();
    const tools: readonly AgentSessionToolName[] = ["read", "brave_search"];

    const detail = createTestSession(store, TEST_NOW, { tools });

    expect(detail.tools).toEqual(tools);
    expect(store.list(TEST_USER_ID)[0]?.tools).toEqual(tools);
    database.$client.close();
  });

  test("uses a fallback title for an image-only task", () => {
    const { database, store } = createStore();
    const detail = createTestSession(store, TEST_NOW, {
      maxContextTokens: null,
      prompt: "",
      reasoningEffort: null,
    });

    expect(detail.title).toBe("Image task");
    database.$client.close();
  });

  test("compacts stored work into a replayable handoff", () => {
    const { database, store } = createStore();
    const session = createTestSession(store);
    expect(session.status).toBe("queued");
    markTestSessionRunning(store);
    store.appendCurrentAgentMessage(
      SESSION_ID,
      { content: "Work in progress.", role: "assistant", toolCalls: [] },
      TEST_NOW + 2,
    );

    store.compactCurrentConversation(
      SESSION_ID,
      "Keep the completed work and run tests.",
      { contextTokens: null, costBasis: null, costUsd: null },
      TEST_NOW + 3,
    );

    expect(store.conversation(SESSION_ID)).toEqual([
      {
        content: testCompactionHandoffMessage(
          "Keep the completed work and run tests.",
        ),
        role: "user",
      },
    ]);
    expect(store.get(TEST_USER_ID, SESSION_ID)?.currentContextTokens).toBe(0);
    database.$client.close();
  });

  test("persists timing for a user-less continuation", () => {
    const setup = runningStore();
    setup.store.appendCurrentAgentMessage(
      SESSION_ID,
      { content: "First response", role: "assistant", toolCalls: [] },
      TEST_NOW + 2,
    );
    expect(
      setup.store.transitionCurrent(SESSION_ID, "idle", TEST_NOW + 3),
    ).toBe(true);
    const before = setup.store.get(TEST_USER_ID, SESSION_ID);

    const queued = setup.store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 100);
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") throw new Error("Session was not queued");
    expectPersistedTurns(queued.detail.turns, before?.messages.at(-1)?.id, {
      endedAt: null,
      startedAt: TEST_NOW + 100,
    });

    expect(
      setup.store.transitionRuntime(
        SESSION_ID,
        "running",
        TEST_NOW + 101,
        queued.detail.generation,
      ),
    ).toBe(true);
    setup.store.appendRuntimeAgentMessages(
      SESSION_ID,
      [{ content: "Continued response", role: "assistant", toolCalls: [] }],
      TEST_NOW + 102,
      queued.detail.generation,
    );
    expect(
      setup.store.transitionRuntime(
        SESSION_ID,
        "idle",
        TEST_NOW + 103,
        queued.detail.generation,
      ),
    ).toBe(true);
    expectPersistedTurns(
      setup.store.get(TEST_USER_ID, SESSION_ID)?.turns,
      before?.messages.at(-1)?.id,
      {
        endedAt: TEST_NOW + 103,
        startedAt: TEST_NOW + 100,
      },
    );
    const finalDetail = setup.store.get(TEST_USER_ID, SESSION_ID);
    expect(finalDetail?.turns?.at(-1)?.boundaryMessageId).toBe(
      finalDetail?.messages.at(-1)?.id,
    );
    setup.database.$client.close();
  });

  test("continues without appending a user message", () => {
    const setup = runningStore();
    expect(
      setup.store.transitionCurrent(SESSION_ID, "idle", TEST_NOW + 2),
    ).toBe(true);
    const before = setup.store.conversation(SESSION_ID);

    const queued = setup.store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 3);

    expect(queued.status).toBe("queued");
    expect(setup.store.conversation(SESSION_ID)).toEqual(before);
    expect(setup.store.get(TEST_USER_ID, SESSION_ID)?.status).toBe("queued");
    setup.database.$client.close();
  });

  test("requires explicit reassignment when an assigned runner is removed", () => {
    const { database, store } = runningStore();
    store.appendCurrentAgentMessage(
      SESSION_ID,
      {
        content: "I will inspect the workspace.",
        role: "assistant",
        toolCalls: [],
      },
      TEST_NOW + 2,
    );

    removeTestRunnerAndExpect({ database, store }, RUNNER_ID, TEST_NOW + 3);

    expectStoredSession(store, SESSION_ID, {
      activeDurationMs: 2,
      activeStartedAt: null,
      runnerId: RUNNER_ID,
      runnerRequired: true,
      status: "idle",
    });
    expect(store.get(TEST_USER_ID, SESSION_ID)?.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        content: "I will inspect the workspace.",
        role: "assistant",
      }),
    ]);
    database.$client.close();
  });

  test("rejects a runtime message after an ordinary stop", () => {
    const { database, store } = runningStore();
    const generation = store.get(TEST_USER_ID, SESSION_ID)?.generation;
    if (generation === undefined) {
      throw new Error("The running session is unavailable");
    }
    expect(store.stop(TEST_USER_ID, SESSION_ID, TEST_NOW + 2)).toBe(true);

    expect(() => {
      store.appendRuntimeAgentMessages(
        SESSION_ID,
        [{ content: "Late stopped output", role: "assistant", toolCalls: [] }],
        TEST_NOW + 3,
        generation,
      );
    }).toThrow("agent session was stopped");
    expect(
      store
        .get(TEST_USER_ID, SESSION_ID)
        ?.messages.some(({ content }) => content === "Late stopped output"),
    ).toBe(false);
    closeSessionStoreTestSetup({ database, store });
  });

  test("stopping a runner-required session preserves reassignment", () => {
    const { database, store } = runningStore();
    removeTestRunnerAndExpect({ database, store }, RUNNER_ID);

    expect(store.stop(TEST_USER_ID, SESSION_ID, TEST_NOW + 3)).toBe(true);

    expectStoredSession(store, SESSION_ID, {
      runnerRequired: true,
      status: "stopped",
    });
    database.$client.close();
  });

  test("keeps an offline runner assigned without requiring reassignment", () => {
    const { database, store } = createStore();
    createTestSession(store);

    const runnerStore = createRunnerStore(database);
    runnerStore.setOnline(RUNNER_ID, TEST_USER_ID, TEST_NOW + 1, false);

    expectStoredSession(store, SESSION_ID, {
      runnerId: RUNNER_ID,
      runnerRequired: false,
      status: "queued",
    });
    database.$client.close();
  });

  test("recovers runner-required sessions without rewriting them on restart", () => {
    const { database, store } = runningStore();
    const before = removeAndReadSession(
      { database, store },
      RUNNER_ID,
      SESSION_ID,
    );

    expectRecoveredSession(database, before, SESSION_ID);
    database.$client.close();
  });

  test("records an error when an active session is interrupted", () => {
    const { database, store } = runningStore();

    store.failInterrupted(TEST_NOW + 2);

    const interrupted = store.get(TEST_USER_ID, SESSION_ID);
    expect(interrupted).toMatchObject({
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
    expect(interrupted?.turns).toHaveLength(1);
    expect(interrupted?.turns?.[0]?.endedAt).not.toBeNull();
    expect(store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 3).status).toBe(
      "queued",
    );
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
    store.appendCurrentAgentMessage(SESSION_ID, assistantMessage, TEST_NOW + 2);
    expect(testSessionMessageRoles(store)).toEqual(["user", "assistant"]);
    store.appendCurrentErrorMessage(SESSION_ID, "Session failed", TEST_NOW + 3);
    expect(store.transitionCurrent(SESSION_ID, "failed", TEST_NOW + 4)).toBe(
      true,
    );
    expectStoredSession(store, SESSION_ID, {
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
