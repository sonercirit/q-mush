import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { runners } from "../../shared/database/schema.ts";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
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

function testSessionInput() {
  return {
    credentialId: CREDENTIAL_ID,
    autoCompact: true,
    images: [TEST_AGENT_IMAGE],
    maxContextTokens: 200_000,
    model: "gpt-4.1-mini",
    prompt: "Inspect the repository\nand make it shine",
    provider: "openai" as const,
    providerPricing: null,
    reasoningEffort: "high" as const,
    runnerId: RUNNER_ID,
    tools: AGENT_SESSION_TOOL_NAMES,
    userId: TEST_USER_ID,
    workingDirectory: "/work/project",
  };
}

function createTestSession(store: SessionStore) {
  return store.create(testSessionInput(), TEST_NOW);
}

function markTestSessionRunning(store: SessionStore): void {
  expect(store.mark(SESSION_ID, "running", TEST_NOW + 1)).toBe(true);
}

function runningStore(): ReturnType<typeof createStore> {
  const setup = createStore();
  createTestSession(setup.store);
  markTestSessionRunning(setup.store);
  return setup;
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
    "018bcfe5-6800-7000-8000-000000000048",
    "018bcfe5-6800-7000-8000-000000000049",
    "018bcfe5-6800-7000-8000-000000000050",
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
    expect(store.mark(SESSION_ID, "failed", TEST_NOW + 3)).toBe(true);
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      activeDurationMs: 2,
      activeStartedAt: null,
      status: "failed",
    });
    expect(testSessionMessageRoles(store)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(
      store.queue(TEST_USER_ID, SESSION_ID, TEST_NOW + 4, {
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
      images: [],
      toolCalls: [],
    });
    expect(store.conversation(SESSION_ID)).toEqual([
      {
        content: "Inspect the repository\nand make it shine",
        images: [TEST_AGENT_IMAGE],
        role: "user",
      },
      assistantMessage,
      interruptedToolResult,
      { content: "Why was it failing?", role: "user" },
    ]);
    database.$client.close();
  });
});
