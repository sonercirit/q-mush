import { describe, expect, test } from "vitest";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  STORE_RUNNER_ID,
  STORE_SESSION_ID,
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

const THINKING_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000045";
const ASSISTANT_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000046";
const TOOL_MESSAGE_ID = "018bcfe5-6800-7000-8000-000000000048";

function prepareForkSource() {
  const setup = createStore();
  const source = createTestSession(setup.store, TEST_NOW, {
    autoCompact: false,
    executionEnvironment: "container",
    maxContextTokens: null,
    model: "fork-model",
    reasoningEffort: null,
    tools: ["read"],
    workingDirectory: "/fork/workspace",
  });
  expect(
    setup.store.transitionCurrent(STORE_SESSION_ID, "running", TEST_NOW + 1),
  ).toBe(true);
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    { content: "Private reasoning", role: "thinking" },
    TEST_NOW + 2,
  );
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    {
      content: "I will inspect the file.",
      role: "assistant",
      toolCalls: [
        { arguments: '{"path":"README.md"}', id: "call-1", name: "read" },
      ],
    },
    TEST_NOW + 3,
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

function forkAtToolMessage(store: ReturnType<typeof createStore>["store"]) {
  return store.fork(
    TEST_USER_ID,
    STORE_SESSION_ID,
    TOOL_MESSAGE_ID,
    TEST_WORKSPACE_ID,
    TEST_NOW + 7,
  );
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
      credentialId: source.credentialId,
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
    expect(store.list(TEST_USER_ID)).toHaveLength(2);
    database.$client.close();
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
