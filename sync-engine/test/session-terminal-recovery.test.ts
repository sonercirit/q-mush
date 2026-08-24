import { inArray } from "drizzle-orm";
import { expect, test } from "vitest";
import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import type { AgentSessionUsageUpdate } from "../../shared/session-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import {
  createSessionStore,
  type SessionStore,
} from "../../sync-engine/session-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  expectCompactedIdleSession,
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import {
  createStore,
  emptyRuntimes,
  testSessionInput,
} from "./session-store-test-fixtures.ts";

const TERMINAL_USAGE: AgentSessionUsageUpdate = {
  contextTokens: 432,
  costBasis: "reported",
  costUsd: 1.25,
};

function terminalMessage(): AgentRecordedMessage {
  return {
    content: "Durable terminal answer.",
    role: "assistant",
    toolCalls: [],
  };
}

function recreate(setup: ReturnType<typeof runningCompactionStore>) {
  return createSessionStore(
    setup.database,
    () => "terminal-recovery-message",
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
}

function recreateCommitted(
  setup: ReturnType<typeof runningCompactionStore>,
  runningSessionId: string,
): SessionStore {
  expect(requireCompactionSession(setup.store).status).toBe("running");
  const recreated = recreate(setup);
  expect(recreated.failInterrupted(TEST_NOW + 3)).toEqual([]);
  expect(recreated.get(TEST_USER_ID, runningSessionId)).toBeDefined();
  return recreated;
}

test("recreation recognizes a terminal assistant append without replaying it", () => {
  const setup = runningCompactionStore();
  const running = requireCompactionSession(setup.store);
  setup.store.appendRuntimeAgentMessages(
    running.id,
    [terminalMessage()],
    TEST_NOW + 2,
    running.generation,
    TERMINAL_USAGE,
  );
  const recreated = recreateCommitted(setup, running.id);
  const settled = requireCompactionSession(recreated);
  expect(settled).toMatchObject({
    costUsd: 1.25,
    currentContextTokens: 432,
    restartHandoff: null,
    status: "idle",
  });
  expect(settled.turns).toHaveLength(1);
  expect(settled.turns?.[0]?.endedAt).not.toBeNull();
  expect(recreated.queue(TEST_USER_ID, running.id, TEST_NOW + 4).status).toBe(
    "queued",
  );
  expect(
    setup.database
      .select({ content: agentMessages.content, role: agentMessages.role })
      .from(agentMessages)
      .all(),
  ).toContainEqual({
    content: "Durable terminal answer.",
    role: "assistant",
  });
  expect(
    JSON.stringify(recreated.get(TEST_USER_ID, running.id)).match(
      /Durable terminal answer\./gu,
    ),
  ).toHaveLength(1);
  closeCompactionStore(setup);
});

test("interrupted terminal child recovery preserves a pending spawn callback", () => {
  const setup = createStore();
  const parentInput = testSessionInput({
    prompt: "Parent with interrupted child",
  });
  const parentResult = setup.store.create(parentInput, TEST_NOW);
  if (parentResult.status !== "created") {
    throw new Error("The recovery parent was not created");
  }
  const parent = parentResult.detail;
  const runningParent = setup.store.transitionCurrent(
    parent.id,
    "running",
    TEST_NOW + 1,
  );
  expect(runningParent).toBe(true);
  const childInput = testSessionInput();
  const created = setup.store.create(
    {
      ...childInput,
      parentGeneration: parent.generation,
      parentSessionId: parent.id,
      prompt: "Finish interrupted child",
    },
    TEST_NOW + 2,
  );
  if (created.status !== "created") {
    throw new Error("The recovery child was not created");
  }
  const child = created.detail;
  const runningChild = setup.store.transitionCurrent(
    child.id,
    "running",
    TEST_NOW + 3,
  );
  expect(runningChild).toBe(true);
  setup.store.appendRuntimeAgentMessages(
    child.id,
    [terminalMessage()],
    TEST_NOW + 4,
    child.generation,
    TERMINAL_USAGE,
  );

  const recreated = createSessionStore(
    setup.database,
    undefined,
    () => DEFAULT_TOOL_SETTINGS,
    emptyRuntimes,
  );
  const pending = recreated.failInterrupted(TEST_NOW + 5);
  const settled = recreated.get(TEST_USER_ID, child.id);
  expect(settled).toMatchObject({
    parentExecutionGeneration: parent.generation,
    parentSessionId: parent.id,
    status: "completed",
  });
  expect(pending).toEqual([{ detail: settled, userId: TEST_USER_ID }]);
  setup.database.$client.close();
});

test("recovery settles a session whose active message is the persisted handoff", () => {
  const setup = runningCompactionStore();
  const session = requireCompactionSession(setup.store);
  setup.store.compactRuntimeConversation(
    session.id,
    "Handoff-only durable summary.",
    { contextTokens: null, costBasis: "reported", costUsd: 1 },
    TEST_NOW + 2,
    session.generation,
    TEST_NOW + 2,
  );
  // Soft-delete the compaction transcript so the handoff user message is the
  // latest active row: recovery must match the real persisted prefix, so a
  // compactionMessage reordering fails here through production writes alone.
  setup.database
    .update(agentMessages)
    .set({ isDeleted: true })
    .where(inArray(agentMessages.role, ["assistant", "compaction_request"]))
    .run();

  const recreated = recreateCommitted(setup, session.id);
  expectCompactedIdleSession(recreated, "Handoff-only durable summary.", {
    costUsd: 1,
  });
  closeCompactionStore(setup);
});

test("recreation recognizes a committed compaction without repeating it", () => {
  const setup = runningCompactionStore();
  const runningSessionId = requireCompactionSession(setup.store).id;
  setup.store.compactRuntimeConversation(
    runningSessionId,
    "One durable compacted history.",
    { contextTokens: null, costBasis: "reported", costUsd: 2 },
    TEST_NOW + 2,
    requireCompactionSession(setup.store).generation,
    TEST_NOW + 2,
  );

  const recreated = recreateCommitted(setup, runningSessionId);
  expectCompactedIdleSession(recreated, "One durable compacted history.", {
    costUsd: 2,
  });
  closeCompactionStore(setup);
});
