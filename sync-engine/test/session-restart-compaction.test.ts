import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import {
  parseRestartHandoff,
  type RestartHandoffSettlement,
} from "../../sync-engine/session-restart-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  claimRestartStore,
  closeCompactionStore,
  forceNewerRestartHandoff,
  forceSessionStatus,
  pauseRestartStore,
  readRawRestartHandoff,
  requireCompactionSession,
  runningRestartStore,
  startClaimedRestart,
  type RestartStoreSetup,
} from "./session-compaction-test-helpers.ts";
import {
  expectRestartState,
  restartStoreAtStatus,
} from "./session-restart-cpd-helpers.ts";

function parsedHandoff(setup: RestartStoreSetup) {
  return setup.restart.parse(readRawRestartHandoff(setup) ?? null);
}

function expectPauseRejected(
  setup: RestartStoreSetup,
  generation: number,
  restartId: string,
): void {
  expect(
    setup.restart.pauseRunning(
      {
        generation,
        sessionId: requireCompactionSession(setup.store).id,
      },
      "server",
      restartId,
      "agent",
      TEST_NOW + 2,
    ),
  ).toBe(false);
  expect(readRawRestartHandoff(setup)).toBeNull();
  closeCompactionStore(setup);
}

function mutateGeneration(setup: RestartStoreSetup, generation: number): void {
  setup.database
    .update(agentSessions)
    .set({ executionGeneration: generation })
    .where(eq(agentSessions.id, requireCompactionSession(setup.store).id))
    .run();
}

function expectNewerHandoffRetained(
  setup: RestartStoreSetup,
  generation: number,
): void {
  expect(parsedHandoff(setup)).toMatchObject({
    executionGeneration: generation,
    restartId: "restart-new",
  });
}

function runningClaimedRestart(restartId: string): {
  readonly identity: ReturnType<typeof pauseRestartStore>;
  readonly setup: RestartStoreSetup;
} {
  const setup = runningRestartStore();
  const identity = pauseRestartStore(setup, restartId);
  claimRestartStore(setup, identity);
  startClaimedRestart(setup, identity);
  return { identity, setup };
}

function settleClaimedRestart(
  setup: RestartStoreSetup,
  identity: ReturnType<typeof pauseRestartStore>,
  settlement: RestartHandoffSettlement,
): void {
  expect(
    setup.restart.settle(TEST_USER_ID, identity, settlement, TEST_NOW + 5),
  ).toBe(true);
}

describe("restart handoff generation fencing", () => {
  test("idle settlement uses a cleared callback route independently", () => {
    const { identity, setup } = runningClaimedRestart("callback-independent");
    setup.database
      .update(agentSessions)
      .set({ parentCallbackGeneration: null, parentExecutionGeneration: 9 })
      .where(eq(agentSessions.id, identity.sessionId))
      .run();

    settleClaimedRestart(setup, identity, { status: "idle" });
    expect(setup.store.get(TEST_USER_ID, identity.sessionId)).toMatchObject({
      parentExecutionGeneration: 9,
      status: "idle",
    });
    closeCompactionStore(setup);
  });

  test("rejects malformed persisted handoffs", () => {
    const valid = {
      executionGeneration: 1,
      operation: "agent",
      pendingInput: [],
      requestedBy: "server",
      restartId: "restart-1",
    };
    const invalid = [
      { ...valid, restartId: "   " },
      { ...valid, unexpected: true },
      { ...valid, pendingInput: ["message"] },
    ];

    for (const handoff of invalid) {
      expect(() => parseRestartHandoff(JSON.stringify(handoff))).toThrow(
        "Stored restart handoff is invalid",
      );
    }
  });

  test("pausing advances authority and persists the exact operation and restart", () => {
    const { identity, setup } = restartStoreAtStatus(
      "paused",
      "restart-compact",
      "compact",
    );
    const runningGeneration = identity.generation - 1;

    expect(requireCompactionSession(setup.store)).toMatchObject({
      activeStartedAt: null,
      generation: identity.generation,
      status: "paused",
    });
    expect(parsedHandoff(setup)).toEqual({
      executionGeneration: identity.generation,
      operation: "compact",
      pendingInput: [],
      requestedBy: "server",
      restartId: identity.restartId,
    });
    expect(
      setup.store.executionIsCurrent(
        TEST_USER_ID,
        identity.sessionId,
        runningGeneration,
      ),
    ).toBe(false);
    closeCompactionStore(setup);
  });

  test.each([
    {
      authority: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
      restartId: "restart-overflow",
      title: "an execution generation that cannot be advanced safely",
    },
    {
      authority: 0,
      generation: 1,
      restartId: "stale-restart",
      title: "a stale runtime pause after a newer execution starts",
    },
  ])("rejects $title", ({ authority, generation, restartId }) => {
    const setup = runningRestartStore();
    mutateGeneration(setup, generation);

    expectPauseRejected(setup, authority, restartId);
  });

  test("claim requires both the persisted generation and exact restart ID", () => {
    const setup = runningRestartStore();
    const identity = pauseRestartStore(setup, "restart-claim");
    const mismatches = [
      { ...identity, restartId: "wrong-restart" },
      { ...identity, generation: identity.generation - 1 },
    ];

    for (const mismatch of mismatches) {
      expect(
        setup.restart.claim(TEST_USER_ID, mismatch, TEST_NOW + 3),
      ).toBeUndefined();
    }
    expect(claimRestartStore(setup, identity)).toMatchObject({
      generation: identity.generation,
      status: "queued",
    });
    closeCompactionStore(setup);
  });

  test("stale restore cannot overwrite a newer handoff", () => {
    const setup = runningRestartStore();
    const stale = pauseRestartStore(setup, "restart-restore-old");
    claimRestartStore(setup, stale);
    forceSessionStatus(setup, "paused");
    const newer = forceNewerRestartHandoff(setup, "restart-new");

    expect(setup.restart.restore(stale, TEST_NOW + 4)).toBe(false);
    expectRestartState(
      requireCompactionSession(setup.store),
      {
        generation: newer.executionGeneration,
        restartId: newer.restartId,
      },
      "paused",
    );
    expectNewerHandoffRetained(setup, newer.executionGeneration);
    closeCompactionStore(setup);
  });

  test("atomically settles an exact recovered handoff after success", () => {
    const { identity, setup } = runningClaimedRestart("restart-terminal");
    expectRestartState(
      requireCompactionSession(setup.store),
      identity,
      "running",
    );

    settleClaimedRestart(setup, identity, { status: "idle" });
    const settled = requireCompactionSession(setup.store);
    expect(settled).toMatchObject({
      activeStartedAt: null,
      restartHandoff: null,
      status: "idle",
    });
    expect(settled.turns?.at(-1)?.endedAt).not.toBeNull();
    expect(
      setup.store.queue(TEST_USER_ID, settled.id, TEST_NOW + 6).status,
    ).toBe("queued");
    closeCompactionStore(setup);
  });

  test("atomically records failure and settles an exact recovered handoff", () => {
    const { identity, setup } = runningClaimedRestart("restart-failure");

    settleClaimedRestart(setup, identity, {
      error: "Session failed: recovered failure",
      status: "failed",
    });
    const failed = requireCompactionSession(setup.store);
    expect(failed.activeStartedAt).toBeNull();
    expect(failed.messages).toMatchObject([
      { role: "user" },
      { content: "Session failed: recovered failure", role: "error" },
    ]);
    expect(failed).toMatchObject({
      restartHandoff: null,
      status: "failed",
    });
    closeCompactionStore(setup);
  });

  test("stale settlement cannot clear a newer handoff", () => {
    const setup = runningRestartStore();
    const stale = pauseRestartStore(setup, "restart-settle-old");
    const newer = forceNewerRestartHandoff(setup, "restart-new");
    forceSessionStatus(setup, "running", TEST_NOW + 3);

    expect(
      setup.restart.settle(
        TEST_USER_ID,
        stale,
        { error: "stale error", status: "failed" },
        TEST_NOW + 4,
      ),
    ).toBe(false);
    expectNewerHandoffRetained(setup, newer.executionGeneration);
    expect(requireCompactionSession(setup.store).messages).toHaveLength(1);
    closeCompactionStore(setup);
  });

  test("startup discovery returns only handoffs matching current authority", () => {
    const setup = runningRestartStore();
    const identity = pauseRestartStore(setup, "restart-pending");
    expect(setup.restart.pending()).toMatchObject([
      {
        handoff: {
          executionGeneration: identity.generation,
          operation: "compact",
          restartId: identity.restartId,
        },
        userId: TEST_USER_ID,
      },
    ]);
    mutateGeneration(setup, identity.generation + 1);

    expect(setup.restart.pending()).toEqual([]);
    closeCompactionStore(setup);
  });
});
