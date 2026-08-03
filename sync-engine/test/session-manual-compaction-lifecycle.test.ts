import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { AgentRecordedMessage } from "../../shared/agent-loop.ts";
import {
  agentSessionOperations,
  agentSessions,
} from "../../shared/database/schema.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  readManualCompactionRows,
  requireCompactionSession,
  runningCompactionStore,
  type CompactionStoreSetup,
} from "./session-compaction-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

function schedule(setup: CompactionStoreSetup): number {
  const generation = requireCompactionSession(setup.store).generation;
  const result = setup.store.scheduleManualCompaction(
    STORE_SESSION_ID,
    generation,
    TEST_NOW + 2,
  );
  expect(result).toBe("scheduled");
  return generation;
}

function transition(
  setup: CompactionStoreSetup,
  generation: number,
  status: "failed" | "running",
  now: number,
): boolean {
  return setup.store.transitionRuntime(
    STORE_SESSION_ID,
    status,
    now,
    generation,
  );
}

function setStoredStatus(
  setup: CompactionStoreSetup,
  generation: number,
  status: "idle" | "stopped",
): void {
  const values =
    status === "idle" ? { activeStartedAt: null, status } : { status };
  const generationMatch = eq(agentSessions.executionGeneration, generation);
  setup.database
    .update(agentSessions)
    .set(values)
    .where(and(eq(agentSessions.id, STORE_SESSION_ID), generationMatch))
    .run();
}

function closeExpectingRetirement(
  setup: CompactionStoreSetup,
  generation: number,
): void {
  const matching = readManualCompactionRows(setup.database).find(
    (row) => row.generation === generation,
  );
  expect(matching?.deleted).toBe(true);
  const stillPending = setup.store.manualCompactionPending(
    STORE_SESSION_ID,
    generation,
  );
  expect(stillPending).toBe(false);
  setup.database.$client.close();
}

function finishScheduledCase(
  action: (setup: CompactionStoreSetup, generation: number) => void,
): void {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  action(setup, generation);
  closeExpectingRetirement(setup, generation);
}

function queueCurrent(setup: CompactionStoreSetup, now: number) {
  const result = setup.store.queue(TEST_USER_ID, STORE_SESSION_ID, now);
  if (result.status !== "queued") {
    throw new Error(`The compaction retry did not queue: ${result.status}`);
  }
  return result.detail;
}

test("successful compaction consumes only its exact generation operation", () => {
  const setup = runningCompactionStore();
  const staleGeneration = schedule(setup);
  expect(transition(setup, staleGeneration, "failed", TEST_NOW + 3)).toBe(true);
  const retried = queueCurrent(setup, TEST_NOW + 4);
  expect(transition(setup, retried.generation, "running", TEST_NOW + 5)).toBe(
    true,
  );

  const staleOperation = and(
    eq(agentSessionOperations.sessionId, STORE_SESSION_ID),
    eq(agentSessionOperations.executionGeneration, staleGeneration),
  );
  setup.database
    .update(agentSessionOperations)
    .set({ isDeleted: false })
    .where(staleOperation)
    .run();
  expect(
    setup.store.scheduleManualCompaction(
      STORE_SESSION_ID,
      retried.generation,
      TEST_NOW + 6,
    ),
  ).toBe("scheduled");
  setup.store.compactRuntimeConversation(
    STORE_SESSION_ID,
    "Exact-generation handoff.",
    { contextTokens: null, costBasis: null, costUsd: null },
    TEST_NOW + 7,
    retried.generation,
    TEST_NOW + 7,
  );

  const rows = readManualCompactionRows(setup.database);
  expect(rows[0]?.deleted).toBe(false);
  expect(rows[0]?.generation).toBe(staleGeneration);
  expect(rows[1]?.deleted).toBe(true);
  expect(rows[1]?.generation).toBe(retried.generation);
  setup.database.$client.close();
});

test("queue generation bump retires superseded compaction operations", () => {
  finishScheduledCase((setup, generation) => {
    setStoredStatus(setup, generation, "idle");
    expect(readManualCompactionRows(setup.database)[0]?.deleted).toBe(false);
    expect(queueCurrent(setup, TEST_NOW + 4).generation).toBe(generation + 1);
  });
});

test("stopping a session retires its scheduled compaction", () => {
  finishScheduledCase((setup) => {
    const stopped = setup.store.stop(
      TEST_USER_ID,
      STORE_SESSION_ID,
      TEST_NOW + 3,
    );
    expect(stopped).toBe(true);
  });
});

test("failing a running session retires its scheduled compaction", () => {
  finishScheduledCase((setup, generation) => {
    expect(transition(setup, generation, "failed", TEST_NOW + 3)).toBe(true);
  });
});

test("normal terminal settlement retires scheduled compaction atomically", () => {
  finishScheduledCase((setup, generation) => {
    const terminal: AgentRecordedMessage = {
      content: "Finished before the compaction boundary.",
      role: "assistant",
      toolCalls: [],
    };
    setup.store.commitRuntimeTerminal(
      STORE_SESSION_ID,
      [terminal],
      TEST_NOW + 3,
      generation,
      null,
    );
    expect(requireCompactionSession(setup.store).status).toBe("idle");
  });
});

test("operation retirement rolls back with a failed terminal transition", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  setStoredStatus(setup, generation, "stopped");
  expect(transition(setup, generation, "failed", TEST_NOW + 3)).toBe(false);
  const retained = readManualCompactionRows(setup.database)[0];
  expect(retained?.deleted).toBe(false);
  expect(retained?.generation).toBe(generation);
  setup.database.$client.close();
});
