import { describe, expect, test } from "vitest";
import {
  agentMessages,
  agentSessionTurns,
} from "../../shared/database/schema.ts";
import { AGENT_COMPACTION_REQUEST_MESSAGE } from "../../sync-engine/agent-compaction.ts";
import type { CompactionUsage } from "../../sync-engine/session-compaction-usage.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { testCompactionHandoffMessage } from "./compaction-test-fixtures.ts";
import {
  appendCompactionAssistantMessage,
  requireCompactionSession,
  runningCompactionStore,
  type CompactionStoreSetup,
} from "./session-compaction-test-helpers.ts";
import { TEST_REPLAY_IDENTITY } from "./session-replay-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

const COMPACTION_TOKEN_USAGE = {
  cacheWriteInputTokens: 500,
  cachedInputTokens: 90_000,
  inputTokens: 98_000,
  outputTokens: 1_000,
} as const;

const COMPACTION_USAGE: CompactionUsage = {
  contextTokens: 98_000,
  costBasis: "reported",
  costUsd: 0.1,
  tokenUsage: COMPACTION_TOKEN_USAGE,
};

function compactionStoreWithUsage(): CompactionStoreSetup {
  const setup = runningCompactionStore();
  appendCompactionAssistantMessage(setup, "Work before compaction.");
  setup.store.updateCurrentUsage(
    STORE_SESSION_ID,
    { contextTokens: 95_000, costBasis: "reported", costUsd: 0.2 },
    TEST_NOW + 3,
  );
  return setup;
}

function compact(setup: CompactionStoreSetup, summary: string): void {
  setup.store.compactCurrentConversation(
    STORE_SESSION_ID,
    summary,
    COMPACTION_USAGE,
    TEST_NOW + 4,
  );
}

function transcriptContains(
  setup: CompactionStoreSetup,
  content: string,
): boolean {
  const transcript = setup.database
    .select({ content: agentMessages.content })
    .from(agentMessages)
    .all();
  return transcript.some((message) => message.content.includes(content));
}

function rejectCompactionWrite(options: {
  readonly name: string;
  readonly statement: string;
  readonly summary: string;
}): void {
  const setup = compactionStoreWithUsage();
  const before = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
  setup.database.$client.run(`
    CREATE TRIGGER ${options.name}
    ${options.statement}
    BEGIN
      SELECT RAISE(ABORT, '${options.name}');
    END
  `);

  expect(() => {
    compact(setup, options.summary);
  }).toThrow(options.name);
  expect(setup.store.get(TEST_USER_ID, STORE_SESSION_ID)).toEqual(before);
  expect(transcriptContains(setup, options.summary)).toBe(false);
  setup.database.$client.close();
}

function expectCurrentCompactionTurn(
  setup: CompactionStoreSetup,
  ended: boolean,
): void {
  const detail = requireCompactionSession(setup.store);
  expect(detail.turns).toHaveLength(1);
  const turn = detail.turns?.[0];
  expect(turn?.endedAt === null).toBe(!ended);
  expect(detail.messages).toMatchObject([{ turnId: turn?.id }]);
}

describe("session compaction persistence", () => {
  test("persists the handoff, context reset, and compaction usage together", () => {
    const setup = compactionStoreWithUsage();
    compact(setup, "Continue from this handoff.");

    const compactedSession = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
    expect(compactedSession).toMatchObject({
      costBasis: "reported",
      currentContextTokens: 0,
      messages: [
        {
          content: testCompactionHandoffMessage("Continue from this handoff."),
          role: "user",
        },
      ],
    });
    expect(compactedSession?.costUsd).toBeCloseTo(0.3);
    expect(compactedSession?.segmentTokenUsage).toMatchObject({
      reportedStepCount: 0,
      stepCount: 0,
    });
    expect(
      setup.store.conversation(STORE_SESSION_ID, TEST_REPLAY_IDENTITY),
    ).toEqual([
      {
        content: testCompactionHandoffMessage("Continue from this handoff."),
        role: "user",
      },
    ]);
    const compactedHistory = setup.store.history(
      TEST_USER_ID,
      STORE_SESSION_ID,
      null,
    );
    expect(compactedHistory?.messages.slice(-2)).toMatchObject([
      {
        content: AGENT_COMPACTION_REQUEST_MESSAGE,
        role: "compaction_request",
      },
      {
        content: "Continue from this handoff.",
        role: "assistant",
        tokenUsage: COMPACTION_TOKEN_USAGE,
      },
    ]);
    expect(compactedHistory?.tokenUsage).toEqual({
      ...COMPACTION_TOKEN_USAGE,
      lastInputTokens: COMPACTION_TOKEN_USAGE.inputTokens,
      reportedStepCount: 1,
      stepCount: 2,
    });
    expect(compactedSession?.tokenUsage).toEqual(compactedHistory?.tokenUsage);
    expectCurrentCompactionTurn(setup, false);
    setup.database.$client.close();
  });

  test("persists and ends the successor turn for terminal compaction", () => {
    const setup = compactionStoreWithUsage();
    const running = requireCompactionSession(setup.store);
    const startedAt = TEST_NOW + 4;
    const endedAt = startedAt + 12_345;

    setup.store.compactRuntimeTerminal(
      running.id,
      "Stop at this handoff.",
      COMPACTION_USAGE,
      endedAt,
      running.generation,
      startedAt,
      null,
    );

    const compacted = requireCompactionSession(setup.store);
    expect(compacted.status).toBe("idle");
    expect(compacted.turns).toMatchObject([{ endedAt, startedAt }]);
    expectCurrentCompactionTurn(setup, true);
    expect(
      setup.database
        .select({ id: agentSessionTurns.id })
        .from(agentSessionTurns)
        .all(),
    ).toHaveLength(2);
    const requeued = setup.store.queue(TEST_USER_ID, running.id, TEST_NOW + 5);
    expect(requeued).toMatchObject({ status: "queued" });
    setup.database.$client.close();
  });

  test("rolls back every compaction write when handoff insertion fails", () => {
    rejectCompactionWrite({
      name: "reject_compaction_handoff",
      statement: "BEFORE INSERT ON agent_messages WHEN NEW.role = 'user'",
      summary: "This handoff must roll back.",
    });
  });

  test("rolls back the handoff when session usage persistence fails", () => {
    rejectCompactionWrite({
      name: "reject_compaction_usage",
      statement:
        "BEFORE UPDATE OF cost_usd ON agent_sessions WHEN NEW.cost_usd > OLD.cost_usd",
      summary: "Usage-failing handoff.",
    });
  });

  test("rejects stale generation compaction without transcript or usage writes", () => {
    const setup = compactionStoreWithUsage();
    const current = requireCompactionSession(setup.store);
    expect(setup.store.stop(TEST_USER_ID, STORE_SESSION_ID, TEST_NOW + 4)).toBe(
      true,
    );
    const stopped = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);

    expect(() => {
      setup.store.compactRuntimeConversation(
        STORE_SESSION_ID,
        "Stale handoff.",
        COMPACTION_USAGE,
        TEST_NOW + 5,
        current.generation,
        TEST_NOW + 5,
      );
    }).toThrow("agent session was stopped");

    expect(setup.store.get(TEST_USER_ID, STORE_SESSION_ID)).toEqual(stopped);
    setup.database.$client.close();
  });
});
