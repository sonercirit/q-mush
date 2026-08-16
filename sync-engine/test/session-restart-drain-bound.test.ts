import { describe, expect, test, vi } from "vitest";
import { RESTART_DRAIN_LIMIT_MS } from "../../shared/development-shutdown.ts";
import { testDeferred } from "../../shared/test/promise-fixtures.ts";
import { createSessionRestartControl } from "../../sync-engine/session-restart-control.ts";
import {
  SessionRuntimes,
  type RestartRequest,
} from "../../sync-engine/session-runtime.ts";
import { SessionRestartTestClock } from "./session-restart-test-clock.ts";

interface PendingRuntime {
  readonly aborted: () => boolean;
  readonly cleared: () => boolean;
  readonly durable: () => readonly RestartRequest[];
  readonly finish: () => void;
}

function pendingRuntime(
  runtimes: SessionRuntimes,
  sessionId: string,
  runnerId = "runner-1",
): PendingRuntime {
  const durable: RestartRequest[] = [];
  let aborted = false;
  let cleared = false;
  const pending = testDeferred<undefined>();
  runtimes.launch(
    sessionId,
    runnerId,
    0,
    "step",
    ({ controller, restartRequest, settled }) => {
      controller.signal.addEventListener("abort", () => {
        aborted = true;
      });
      restartRequest((request, isDurable) => {
        if (isDurable) {
          durable.push(request);
        }
      });
      settled(() => {
        cleared = true;
      });
      return pending.promise;
    },
  );
  return {
    aborted: () => aborted,
    cleared: () => cleared,
    durable: () => durable,
    finish: () => {
      pending.resolve(undefined);
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
}

function testRestartControl(
  clock: SessionRestartTestClock,
  runtimes: SessionRuntimes,
  logged: string[] = [],
) {
  let restartId = 0;
  return createSessionRestartControl(
    runtimes,
    () => `restart-${String((restartId += 1))}`,
    {
      clearTimeout: clock.clearTimeout,
      warn: (message) => logged.push(message),
      pendingTools: (sessionId) => [`bash:${sessionId}`],
      setTimeout: clock.setTimeout,
    },
  );
}

function restartRuntimeFixture(logged: string[] = []) {
  const clock = new SessionRestartTestClock();
  const runtimes = new SessionRuntimes(clock.now);
  return {
    clock,
    control: testRestartControl(clock, runtimes, logged),
    runtimes,
  };
}

async function drainingServer(
  sessionIds: readonly (readonly [string, string])[],
  logged: string[] = [],
) {
  const fixture = restartRuntimeFixture(logged);
  const sessions = sessionIds.map(([sessionId, runnerId]) =>
    pendingRuntime(fixture.runtimes, sessionId, runnerId),
  );
  await Promise.resolve();
  return { ...fixture, sessions };
}

// Wrapped: returning the promise itself would flatten into the awaited
// result, so the caller would block on the whole drain instead of starting it.
async function startedDrain(
  control: ReturnType<typeof testRestartControl>,
  kind: "runner" | "server" = "server",
): Promise<{ readonly drained: Promise<void> }> {
  const drained =
    kind === "server"
      ? control.drainServer()
      : control.drainRunner("runner-1", "runner-restart");
  await waitUntil(() => control.drainProgress().length > 0);
  return { drained };
}

async function advanceDrain(
  clock: SessionRestartTestClock,
  control: ReturnType<typeof testRestartControl>,
  milliseconds: number,
): Promise<void> {
  const { drained } = await startedDrain(control);
  clock.advance(milliseconds);
  await drained;
}

function onlySession(sessions: readonly PendingRuntime[]): PendingRuntime {
  const [session] = sessions;
  if (session === undefined) {
    throw new Error("The drain fixture launched no session");
  }
  return session;
}

async function singleSessionDrain(logged: string[] = []) {
  const drained = await drainingServer([["session-1", "runner-1"]], logged);
  return { ...drained, session: onlySession(drained.sessions) };
}

function expectForceParked(session: PendingRuntime): void {
  expect(session.aborted()).toBe(true);
  expect(session.durable()).toHaveLength(1);
}

function pendingRunnerDrain() {
  const fixture = restartRuntimeFixture();
  const runtime = pendingRuntime(
    fixture.runtimes,
    "runner-session",
    "runner-1",
  );
  return { ...fixture, runtime };
}

function expectRunnerRequest(runtimes: SessionRuntimes): void {
  expect(
    runtimes.drainRequest({ kind: "runner", runnerId: "runner-1" }),
  ).toEqual({
    boundary: "handoff",
    requestedBy: "runner",
    restartId: "runner-restart",
  });
}

describe("bounded restart drain", () => {
  test("force-parks sessions still running when the drain limit expires", async () => {
    const {
      clock,
      control,
      runtimes,
      session: stuck,
    } = await singleSessionDrain();

    await advanceDrain(clock, control, RESTART_DRAIN_LIMIT_MS);

    expectForceParked(stuck);
    expect(stuck.durable()).toEqual([
      { boundary: "step", requestedBy: "server", restartId: "restart-1" },
    ]);
    stuck.finish();
    await runtimes.cleared("session-1");
    expect(stuck.cleared()).toBe(false);
  });

  test("waits for sessions that settle before the drain limit", async () => {
    const { clock, control, session: settling } = await singleSessionDrain();
    const { drained } = await startedDrain(control);
    clock.advance(RESTART_DRAIN_LIMIT_MS / 2);
    settling.finish();
    await drained;

    expect(settling.aborted()).toBe(false);
    expect(settling.cleared()).toBe(true);
  });

  test("escalates a second restart request instead of hanging or stopping", async () => {
    const { control, session: stuck } = await singleSessionDrain();
    const { drained: first } = await startedDrain(control);
    await control.drainServer();
    await first;

    expectForceParked(stuck);
  });

  test("timer and repeated-request escalation race force-parks once", async () => {
    const logged: string[] = [];
    const fixture = await singleSessionDrain(logged);
    const { clock, control, session: stuck } = fixture;
    const { drained: first } = await startedDrain(control);

    const second = control.drainServer();
    clock.advance(RESTART_DRAIN_LIMIT_MS);
    await Promise.all([first, second]);

    expectForceParked(stuck);
    expect(stuck.durable()).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  test("runner drains preserve runner provenance without a server durable marker", async () => {
    const { control, runtime, runtimes } = pendingRunnerDrain();
    const { drained } = await startedDrain(control, "runner");
    expect(runtime.durable()).toEqual([]);
    runtime.finish();
    await drained;
    expectRunnerRequest(runtimes);
  });

  test("final preparation neutralizes armed runner escalation timers", async () => {
    const { clock, control, runtime } = pendingRunnerDrain();
    const { drained: runnerDrain } = await startedDrain(control, "runner");
    await control.prepareServerShutdown();
    control.cancelBoundedRunnerDrains();
    clock.advance(RESTART_DRAIN_LIMIT_MS);
    await runnerDrain;

    expect(runtime.aborted()).toBe(false);
    runtime.finish();
  });

  test("reports the sessions, tool calls and elapsed time a drain waits on", async () => {
    const logged: string[] = [];
    const { clock, control } = await drainingServer(
      [
        ["session-1", "runner-1"],
        ["session-2", "runner-2"],
      ],
      logged,
    );

    expect(control.drainProgress()).toEqual([]);
    const { drained } = await startedDrain(control);
    clock.advance(1_500);

    expect(control.drainProgress()).toEqual([
      {
        elapsedMs: 1_500,
        runnerId: "runner-1",
        sessionId: "session-1",
        tools: ["bash:session-1"],
      },
      {
        elapsedMs: 1_500,
        runnerId: "runner-2",
        sessionId: "session-2",
        tools: ["bash:session-2"],
      },
    ]);

    clock.advance(RESTART_DRAIN_LIMIT_MS);
    await drained;
    await waitUntil(() => control.drainProgress().length === 0);
    expect(logged).toEqual([
      expect.stringContaining(
        "force-parked 2 session(s) still running at the restart drain limit",
      ),
    ]);
    expect(logged[0]).toContain("session-1 bash:session-1 (122s)");
  });
});
