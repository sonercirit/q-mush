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
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { STORE_SESSION_ID } from "./session-store-test-fixtures.ts";

function pendingOperationRows(
  setup: ReturnType<typeof runningCompactionStore>,
) {
  return setup.database
    .select({
      deleted: agentSessionOperations.isDeleted,
      generation: agentSessionOperations.executionGeneration,
    })
    .from(agentSessionOperations)
    .where(eq(agentSessionOperations.sessionId, STORE_SESSION_ID))
    .orderBy(agentSessionOperations.executionGeneration)
    .all();
}

function schedule(setup: ReturnType<typeof runningCompactionStore>): number {
  const generation = requireCompactionSession(setup.store).generation;
  expect(
    setup.store.scheduleManualCompaction(
      STORE_SESSION_ID,
      generation,
      TEST_NOW + 2,
    ),
  ).toBe("scheduled");
  return generation;
}

function expectRetired(
  setup: ReturnType<typeof runningCompactionStore>,
  generation: number,
): void {
  expect(pendingOperationRows(setup)).toContainEqual({
    deleted: true,
    generation,
  });
  expect(
    setup.store.manualCompactionPending(STORE_SESSION_ID, generation),
  ).toBe(false);
  setup.database.$client.close();
}

test("successful compaction consumes only its exact generation operation", () => {
  const setup = runningCompactionStore();
  const staleGeneration = schedule(setup);
  expect(
    setup.store.transitionRuntime(
      STORE_SESSION_ID,
      "failed",
      TEST_NOW + 3,
      staleGeneration,
    ),
  ).toBe(true);
  const queued = setup.store.queue(
    TEST_USER_ID,
    STORE_SESSION_ID,
    TEST_NOW + 4,
  );
  if (queued.status !== "queued") {
    throw new Error("The compaction retry did not queue");
  }
  const generation = queued.detail.generation;
  expect(
    setup.store.transitionRuntime(
      STORE_SESSION_ID,
      "running",
      TEST_NOW + 5,
      generation,
    ),
  ).toBe(true);
  setup.database
    .update(agentSessionOperations)
    .set({ isDeleted: false })
    .where(
      and(
        eq(agentSessionOperations.sessionId, STORE_SESSION_ID),
        eq(agentSessionOperations.executionGeneration, staleGeneration),
      ),
    )
    .run();
  expect(
    setup.store.scheduleManualCompaction(
      STORE_SESSION_ID,
      generation,
      TEST_NOW + 6,
    ),
  ).toBe("scheduled");

  setup.store.compactRuntimeConversation(
    STORE_SESSION_ID,
    "Exact-generation handoff.",
    { contextTokens: null, costBasis: null, costUsd: null },
    TEST_NOW + 7,
    generation,
    TEST_NOW + 7,
  );

  expect(pendingOperationRows(setup)).toEqual([
    { deleted: false, generation: staleGeneration },
    { deleted: true, generation },
  ]);
  setup.database.$client.close();
});

test("queue generation bump retires superseded compaction operations", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  setup.database
    .update(agentSessions)
    .set({ activeStartedAt: null, status: "idle" })
    .where(
      and(
        eq(agentSessions.id, STORE_SESSION_ID),
        eq(agentSessions.executionGeneration, generation),
      ),
    )
    .run();
  expect(pendingOperationRows(setup)).toEqual([{ deleted: false, generation }]);
  const queued = setup.store.queue(
    TEST_USER_ID,
    STORE_SESSION_ID,
    TEST_NOW + 4,
  );
  expect(queued).toMatchObject({
    detail: { generation: generation + 1 },
    status: "queued",
  });
  expectRetired(setup, generation);
});

test("stopping a session retires its scheduled compaction", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  expect(setup.store.stop(TEST_USER_ID, STORE_SESSION_ID, TEST_NOW + 3)).toBe(
    true,
  );
  expectRetired(setup, generation);
});

test("failing a running session retires its scheduled compaction", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  expect(
    setup.store.transitionRuntime(
      STORE_SESSION_ID,
      "failed",
      TEST_NOW + 3,
      generation,
    ),
  ).toBe(true);
  expectRetired(setup, generation);
});

test("normal terminal settlement retires scheduled compaction atomically", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
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
  expectRetired(setup, generation);
});

test("operation retirement rolls back with a failed terminal transition", () => {
  const setup = runningCompactionStore();
  const generation = schedule(setup);
  setup.database
    .update(agentSessions)
    .set({ status: "stopped" })
    .where(
      and(
        eq(agentSessions.id, STORE_SESSION_ID),
        eq(agentSessions.executionGeneration, generation),
      ),
    )
    .run();

  expect(
    setup.store.transitionRuntime(
      STORE_SESSION_ID,
      "failed",
      TEST_NOW + 3,
      generation,
    ),
  ).toBe(false);
  expect(pendingOperationRows(setup)).toEqual([{ deleted: false, generation }]);
  setup.database.$client.close();
});
