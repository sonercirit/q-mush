import { expect, test } from "vitest";
import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import { agentMessages } from "../../shared/database/schema.ts";
import type { AgentSessionUsageUpdate } from "../../shared/session-model.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
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
  return new SessionStore(setup.database, () => "terminal-recovery-message");
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

test("recreation recognizes a committed compaction without repeating it", () => {
  const setup = runningCompactionStore();
  const runningSessionId = requireCompactionSession(setup.store).id;
  setup.store.compactRuntimeConversation(
    runningSessionId,
    "One durable compacted history.",
    { contextTokens: null, costBasis: "reported", costUsd: 2 },
    TEST_NOW + 2,
    requireCompactionSession(setup.store).generation,
  );

  const recreated = recreateCommitted(setup, runningSessionId);
  expectCompactedIdleSession(recreated, "One durable compacted history.", {
    costUsd: 2,
  });
  closeCompactionStore(setup);
});
