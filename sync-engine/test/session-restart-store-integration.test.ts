import { expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import type { RestartHandoffOperation } from "../../shared/session-model.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import { ShutdownInterruptedSessionStore } from "../../sync-engine/session-shutdown-interrupted-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  forceNewerRestartHandoff,
  pauseRestartStore,
  readRawRestartHandoff,
  runningRestartStore,
  type RestartStoreSetup,
} from "./session-compaction-test-helpers.ts";
import {
  expectRestartState,
  restartStoreAtStatus,
} from "./session-restart-cpd-helpers.ts";
import {
  STORE_RUNNER_ID,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

function pause(
  setup: RestartStoreSetup,
  restartId: string,
  operation: RestartHandoffOperation = "agent",
) {
  return pauseRestartStore(setup, restartId, operation);
}

function projectedSession(setup: RestartStoreSetup) {
  return setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
}

function expectInterruptedRestored(
  setup: RestartStoreSetup,
  expected: {
    readonly generation: number;
    readonly handoff: unknown;
  },
): void {
  expect(projectedSession(setup)).toMatchObject({
    activeStartedAt: null,
    generation: expected.generation,
    messages: [{ role: "user" }],
    restartHandoff: expected.handoff,
    status: "paused",
  });
}

function interruptedStore(setup: RestartStoreSetup) {
  return new ShutdownInterruptedSessionStore({
    database: setup.database,
    generateId: () => `shutdown-interrupted-${crypto.randomUUID()}`,
  });
}

function rawInterruptedMarker(setup: RestartStoreSetup): string | null {
  return (
    setup.database
      .select({ marker: agentSessions.interruptedHandoff })
      .from(agentSessions)
      .get()?.marker ?? null
  );
}

test("restores a running session from a durable shutdown interruption marker", () => {
  const setup = runningRestartStore();
  const running = projectedSession(setup);
  if (running === undefined) {
    throw new Error("The shutdown interruption session is unavailable");
  }
  const interrupted = interruptedStore(setup);

  expect(
    interrupted.mark(
      running.id,
      running.generation,
      "bounded-final-shutdown",
      "agent",
      TEST_NOW + 2,
    ),
  ).toBe(true);
  expect(rawInterruptedMarker(setup)).not.toBeNull();
  interrupted.restore(TEST_NOW + 3);

  const recovered = projectedSession(setup);
  expect(recovered).toMatchObject({
    activeStartedAt: null,
    generation: running.generation + 1,
    messages: running.messages,
    restartHandoff: {
      executionGeneration: running.generation + 1,
      operation: "agent",
      requestedBy: "server",
      restartId: "bounded-final-shutdown",
    },
    status: "paused",
  });
  expect(rawInterruptedMarker(setup)).toBeNull();
  expect(recovered).not.toMatchObject({ status: "failed" });
  expect(setup.store.failInterrupted(TEST_NOW + 4)).toHaveLength(0);
  closeCompactionStore(setup);
});

test("converts a corrupt shutdown marker into a corrupt restart handoff", () => {
  const setup = runningRestartStore();
  setup.database
    .update(agentSessions)
    .set({ interruptedHandoff: "not-json" })
    .run();
  const interrupted = interruptedStore(setup);

  interrupted.failInvalid(TEST_NOW + 2);

  expect(rawInterruptedMarker(setup)).toBeNull();
  const invalid = setup.store.invalidRestartHandoffs()[0];
  if (invalid === undefined) {
    throw new Error("The corrupt converted handoff is unavailable");
  }
  expect(
    setup.store.failInvalidRestartHandoff(
      invalid,
      "Session failed: Stored restart handoff is invalid",
      TEST_NOW + 3,
    ),
  ).toBe(true);
  const failed = projectedSession(setup);
  expect(failed?.restartHandoff).toBeNull();
  expect(failed?.status).toBe("failed");
  const hasCorruptionError =
    failed?.messages.some(
      (message) =>
        message.role === "error" &&
        message.content.includes("Stored restart handoff is invalid"),
    ) ?? false;
  expect(hasCorruptionError).toBe(true);
  closeCompactionStore(setup);
});

function expectRestartCleared(setup: RestartStoreSetup): void {
  expect(readRawRestartHandoff(setup)).toBeNull();
  expect(setup.store.pendingRestartHandoffs()).toEqual([]);
}

test("projects paused handoffs without synthetic interrupted tool results", () => {
  const setup = runningRestartStore();
  setup.store.appendCurrentAgentMessage(
    STORE_SESSION_ID,
    {
      content: "Restarting after this command.",
      role: "assistant",
      toolCalls: [
        {
          arguments: '{"command":"bun run check"}',
          id: "call-1",
          name: "bash",
        },
      ],
    },
    TEST_NOW + 2,
  );
  const identity = pause(setup, "restart-projection");

  expect(projectedSession(setup)).toMatchObject({
    generation: identity.generation,
    messages: [
      { role: "user" },
      { role: "assistant", toolCalls: [{ id: "call-1" }] },
    ],
    restartHandoff: {
      executionGeneration: identity.generation,
      operation: "agent",
      restartId: identity.restartId,
    },
    status: "paused",
  });
  expect(setup.store.conversation(STORE_SESSION_ID, false)).toHaveLength(2);
  expect(setup.store.pendingRestartHandoffs()).toHaveLength(1);
  closeCompactionStore(setup);
});

test("stopping a paused session clears its exact restart handoff", () => {
  const setup = runningRestartStore();
  const identity = pause(setup, "restart-stop", "compact_and_continue");

  expect(setup.store.stop(TEST_USER_ID, STORE_SESSION_ID, TEST_NOW + 3)).toBe(
    true,
  );
  expect(projectedSession(setup)).toMatchObject({
    generation: identity.generation,
    restartHandoff: null,
    status: "stopped",
  });
  expectRestartCleared(setup);
  closeCompactionStore(setup);
});

test.each(["paused", "queued", "running"] as const)(
  "runner removal atomically clears a %s restart handoff",
  (handoffStatus) => {
    const { identity, setup } = restartStoreAtStatus(
      handoffStatus,
      `restart-remove-${handoffStatus}`,
      "agent",
    );
    const before = projectedSession(setup);
    if (before === undefined) {
      throw new Error("The restart removal test session is unavailable");
    }
    expectRestartState(before, identity, handoffStatus);
    expect(before).toMatchObject({
      runnerId: STORE_RUNNER_ID,
      runnerRequired: false,
    });

    const removalNow = TEST_NOW + 6;
    const runnerStore = new RunnerStore(setup.database);
    expect(runnerStore.remove(TEST_USER_ID, STORE_RUNNER_ID, removalNow)).toBe(
      true,
    );

    const activeDurationMs =
      handoffStatus === "running"
        ? before.activeDurationMs +
          (before.activeStartedAt === null
            ? 0
            : removalNow - before.activeStartedAt)
        : before.activeDurationMs;
    expect(projectedSession(setup)).toMatchObject({
      activeDurationMs,
      activeStartedAt: null,
      generation: identity.generation + 1,
      messages: before.messages,
      restartHandoff: null,
      runnerId: STORE_RUNNER_ID,
      runnerRequired: true,
      status: "idle",
      updatedAt: removalNow,
    });
    expectRestartCleared(setup);
    closeCompactionStore(setup);
  },
);

test.each(["queued", "running"] as const)(
  "restores an interrupted exact %s restart claim without failure",
  (claimedStatus) => {
    const { identity, setup } = restartStoreAtStatus(
      claimedStatus,
      `restart-${claimedStatus}`,
      "agent",
    );

    expect(setup.store.failInterrupted(TEST_NOW + 5)).toEqual([]);
    expectRestartState(projectedSession(setup), identity, "paused");
    expect(projectedSession(setup)?.messages).toMatchObject([{ role: "user" }]);
    closeCompactionStore(setup);
  },
);

test("stale interrupted work cannot clear a newer handoff", () => {
  const setup = runningRestartStore();
  const stale = pause(setup, "restart-stale");
  const newerHandoff = forceNewerRestartHandoff(
    setup,
    "restart-newer",
    "queued",
  );

  const expectedNewer = {
    generation: newerHandoff.executionGeneration,
    handoff: newerHandoff,
  };

  expect(setup.store.failInterrupted(TEST_NOW + 4)).toEqual([]);
  expectInterruptedRestored(setup, expectedNewer);
  expect(setup.store.restoreRestartHandoff(stale, TEST_NOW + 5)).toBe(false);
  expectInterruptedRestored(setup, expectedNewer);
  closeCompactionStore(setup);
});
