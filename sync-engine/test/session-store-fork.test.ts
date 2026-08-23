import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { replayIdentity } from "./session-replay-test-helpers.ts";
import { markTestSessionRunning } from "./session-store-lifecycle-test-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_RUNNER_ID,
  STORE_SESSION_ID,
  testSessionInput,
} from "./session-store-test-fixtures.ts";

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-provider-replay-",
);

const THINKING_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000045";
const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000046";
const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000048";
const REPLAY_BLOCKS = [
  {
    signature: "persisted-signature",
    thinking: "Private reasoning",
    type: "thinking" as const,
  },
  { data: "persisted-redaction", type: "redacted_thinking" as const },
  { text: "I will inspect the file.", type: "text" as const },
  {
    id: "call-1",
    input: { path: "README.md" },
    name: "read",
    type: "tool_use" as const,
  },
] as const;
const PROVIDER_REPLAY = {
  blocks: REPLAY_BLOCKS,
  model: "fork-model",
  protocol: "anthropic" as const,
  provenance: "test-provenance",
};

const FORK_ASSISTANT_MESSAGE = {
  content: "I will inspect the file.",
  providerReplay: PROVIDER_REPLAY,
  role: "assistant" as const,
  toolCalls: [
    {
      arguments: '{"path":"README.md"}',
      id: "call-1",
      name: "read",
    },
  ],
};

const TOKEN_USAGE = {
  outputTokens: 20,
  inputTokens: 100,
  cacheWriteInputTokens: 0,
  cachedInputTokens: 30,
} as const;

function prepareForkSource() {
  const setup = createStore();
  const source = createTestSession(setup.store, TEST_NOW, {
    autoCompact: false,
    executionEnvironment: "container",
    // Non-default so the fork copy assertion cannot pass by accident.
    idleCompact: true,
    maxContextTokens: null,
    maxOutputTokens: null,
    model: "fork-model",
    reasoningEffort: null,
    tools: ["read"],
    workingDirectory: "/fork/workspace",
  });
  markTestSessionRunning(setup.store);
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    { content: "Private reasoning", role: "thinking" },
    TEST_NOW + 2,
  );
  setup.store.appendRuntimeAgentMessages(
    STORE_SESSION_ID,
    [FORK_ASSISTANT_MESSAGE],
    TEST_NOW + 3,
    source.generation,
    {
      tokenUsage: TOKEN_USAGE,
      costUsd: null,
      costBasis: null,
      contextTokens: 100,
    },
  );
  setup.store.appendCurrentErrorMessage(
    STORE_SESSION_ID,
    "Transient provider warning",
    TEST_NOW + 4,
  );
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    {
      content: "Project documentation",
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
    },
    TEST_NOW + 5,
  );
  return { ...setup, source };
}

function requireForked(
  result: ReturnType<ReturnType<typeof createStore>["store"]["fork"]>,
) {
  if (result.status !== "forked") throw new Error("The fork failed");
  return result.detail;
}

function forkAtToolMessage(
  store: ReturnType<typeof createStore>["store"],
  selection?: Parameters<ReturnType<typeof createStore>["store"]["fork"]>[5],
) {
  return store.fork(
    TEST_USER_ID,
    STORE_SESSION_ID,
    TOOL_MESSAGE_ID,
    TEST_WORKSPACE_ID,
    TEST_NOW + 7,
    selection,
  );
}

function replayConversation(
  store: ReturnType<typeof createStore>["store"],
  sessionId: string,
) {
  return store.conversation(
    sessionId,
    replayIdentity(PROVIDER_REPLAY.model, PROVIDER_REPLAY.provenance),
  );
}

function forkAssistant(
  store: ReturnType<typeof createStore>["store"],
  sessionId: string,
) {
  return replayConversation(store, sessionId).find(
    ({ role }) => role === "assistant",
  );
}

function expectPublicMessagesHideReplay(messages: readonly unknown[]): void {
  expect(messages[1]).not.toHaveProperty("providerReplay");
  expect(JSON.stringify(messages)).not.toContain("persisted-signature");
}

function replacementForkSelection(
  source: ReturnType<typeof prepareForkSource>["source"],
) {
  return {
    adaptiveThinking: false,
    credentialId: source.credentialId,
    maxContextTokens: 256_000,
    maxOutputTokens: null,
    model: "replacement/model",
    openRouterProviderTag: null,
    provider: "openrouter" as const,
    providerPricing: null,
    reasoningEffort: "high" as const,
  };
}

function replacementFork() {
  const setup = prepareForkSource();
  const result = forkAtToolMessage(
    setup.store,
    replacementForkSelection(setup.source),
  );
  return { ...setup, fork: requireForked(result) };
}

describe("session store forks", () => {
  test("copies conversation context through the inclusive fork point", () => {
    const { database, source, store } = prepareForkSource();
    new RunnerStore(database).setOnline(
      STORE_RUNNER_ID,
      TEST_USER_ID,
      TEST_NOW + 6,
      false,
    );

    const result = forkAtToolMessage(store);

    const fork = requireForked(result);
    expect(fork).toMatchObject({
      autoCompact: source.autoCompact,
      adaptiveThinking: source.adaptiveThinking,
      credentialId: source.credentialId,
      idleCompact: source.idleCompact,
      executionEnvironment: source.executionEnvironment,
      maxContextTokens: source.maxContextTokens,
      model: source.model,
      openRouterProviderTag: source.openRouterProviderTag,
      parentExecutionGeneration: null,
      parentSessionId: null,
      provider: source.provider,
      providerPricing: source.providerPricing,
      reasoningEffort: source.reasoningEffort,
      runnerId: source.runnerId,
      status: "idle",
      tools: source.tools,
      workingDirectory: source.workingDirectory,
      workspaceId: source.workspaceId,
    });
    expect(fork.title).toBe(`Fork of ${source.title}`.slice(0, 80));
    expect(fork.id).not.toBe(source.id);
    expect(fork.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(fork.messages.map(({ createdAt }) => createdAt)).toEqual([
      TEST_NOW,
      TEST_NOW + 3,
      TEST_NOW + 5,
    ]);
    const copiedIds = new Set(fork.messages.map(({ id }) => id));
    for (const sourceId of [
      THINKING_MESSAGE_ID,
      ASSISTANT_MESSAGE_ID,
      TOOL_MESSAGE_ID,
    ]) {
      expect(copiedIds.has(sourceId)).toBe(false);
    }
    expect(fork.messages[0]?.images).toEqual(source.messages[0]?.images);
    const forkConversation = replayConversation(store, fork.id);
    expect(forkConversation[1]).toMatchObject({
      providerReplay: PROVIDER_REPLAY,
    });
    expectPublicMessagesHideReplay(fork.messages);
    expect(store.list(TEST_USER_ID)).toHaveLength(2);
    database.$client.close();
  });

  test("replays signed metadata after reopening the database", () => {
    const path = join(temporaryDirectory(), "session.sqlite");
    const database = createAuthenticatedTestDatabase({ path });
    addSessionTestRunner(database, "replay-restart-machine", STORE_RUNNER_ID);
    addTestProviderCredential(database, testSessionInput().credentialId);
    const ids = [
      STORE_SESSION_ID,
      "018bcfe5-6800-7000-8000-000000000044",
      "018bcfe5-6800-7000-8000-000000000045",
    ];
    const store = new SessionStore(
      database,
      () => {
        const replayId = ids.shift();
        if (replayId === undefined) {
          throw new Error("No fork replay test ID remains");
        }
        return replayId;
      },
      () => DEFAULT_TOOL_SETTINGS,
      { pending: () => undefined },
    );
    createTestSession(store, TEST_NOW, {
      images: [],
      model: PROVIDER_REPLAY.model,
    });
    markTestSessionRunning(store);
    store.appendCurrentAgentMessage(
      STORE_SESSION_ID,
      FORK_ASSISTANT_MESSAGE,
      TEST_NOW + 2,
    );
    database.$client.close();

    const reopened = createDatabase(path);
    expect(
      replayConversation(
        new SessionStore(reopened, undefined, () => DEFAULT_TOOL_SETTINGS, {
          pending: () => undefined,
        }),
        STORE_SESSION_ID,
      )[1],
    ).toEqual(expect.objectContaining({ providerReplay: PROVIDER_REPLAY }));
    reopened.$client.close();
  });

  test("preserves persisted assistant usage in a fork", () => {
    const { database, store } = prepareForkSource();
    const source = store.get(TEST_USER_ID, STORE_SESSION_ID);

    const fork = requireForked(
      store.fork(
        TEST_USER_ID,
        STORE_SESSION_ID,
        ASSISTANT_MESSAGE_ID,
        TEST_WORKSPACE_ID,
        TEST_NOW + 7,
      ),
    );

    const expected = {
      ...TOKEN_USAGE,
      lastInputTokens: TOKEN_USAGE.inputTokens,
      reportedStepCount: 1,
      stepCount: 1,
    };
    expect(source?.tokenUsage).toEqual(expected);
    expect(fork.tokenUsage).toEqual(expected);
    expect(fork.segmentTokenUsage).toEqual(expected);
    expect(
      fork.messages.find(({ role }) => role === "assistant")?.tokenUsage,
    ).toEqual(TOKEN_USAGE);
    database.$client.close();
  });

  test("creates a fork with a chosen provider and model", () => {
    const { database, fork, source } = replacementFork();

    expect(fork).toMatchObject({
      adaptiveThinking: false,
      credentialId: source.credentialId,
      executionEnvironment: source.executionEnvironment,
      maxContextTokens: 256_000,
      model: "replacement/model",
      provider: "openrouter",
      reasoningEffort: "high",
      runnerId: source.runnerId,
      workingDirectory: source.workingDirectory,
    });
    database.$client.close();
  });

  test("drops signed replay when a fork changes models", () => {
    const { database, fork, store } = replacementFork();

    const assistant = forkAssistant(store, fork.id);
    expect(assistant).not.toHaveProperty("providerReplay");
    database.$client.close();
  });

  test("drops signed replay when a fork changes credentials", () => {
    const setup = prepareForkSource();
    addTestProviderCredential(setup.database, "replacement-credential");
    const selection = {
      ...replacementForkSelection(setup.source),
      credentialId: "replacement-credential",
      model: setup.source.model,
      provider: setup.source.provider,
    };
    const fork = requireForked(forkAtToolMessage(setup.store, selection));

    const assistant = forkAssistant(setup.store, fork.id);
    expect(assistant).not.toHaveProperty("providerReplay");
    setup.database.$client.close();
  });

  test("preserves a source runner reassignment requirement", () => {
    const { database, store } = prepareForkSource();
    expect(
      new RunnerStore(database).remove(
        TEST_USER_ID,
        STORE_RUNNER_ID,
        TEST_NOW + 6,
      ),
    ).toBe(true);
    expect(store.get(TEST_USER_ID, STORE_SESSION_ID)).toMatchObject({
      runnerId: STORE_RUNNER_ID,
      runnerRequired: true,
    });

    const result = forkAtToolMessage(store);

    expect(requireForked(result)).toMatchObject({
      runnerId: STORE_RUNNER_ID,
      runnerRequired: true,
    });
    database.$client.close();
  });

  test("rejects an unknown fork point or incorrectly scoped source", () => {
    const { database, store } = prepareForkSource();

    const inaccessible = store.fork.bind(store, TEST_USER_ID, STORE_SESSION_ID);
    expect(
      inaccessible("missing-message", TEST_WORKSPACE_ID, TEST_NOW + 6),
    ).toEqual({ status: "fork_point_not_found" });
    expect(
      inaccessible(TOOL_MESSAGE_ID, "other-workspace", TEST_NOW + 6),
    ).toEqual({ status: "not_found" });
    expect(store.list(TEST_USER_ID).map(({ id }) => id)).toEqual([
      STORE_SESSION_ID,
    ]);
    database.$client.close();
  });
});
