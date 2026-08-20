import { describe, expect, test, vi } from "vitest";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../../shared/development-shutdown.ts";
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

function observeAbort(controller: AbortController, onAbort: () => void): void {
  controller.signal.addEventListener("abort", onAbort);
}

function markAborted(state: { value: boolean }): void {
  state.value = true;
}

function captureAbort(
  controller: AbortController,
): Readonly<{ aborted: () => boolean }> {
  const state = { value: false };
  observeAbort(controller, () => {
    markAborted(state);
  });
  return { aborted: () => state.value };
}

function pendingRuntime(
  runtimes: SessionRuntimes,
  sessionId: string,
  runnerId = "runner-1",
): PendingRuntime {
  const durable: RestartRequest[] = [];
  let abortState: Readonly<{ aborted: () => boolean }> | undefined;
  let cleared = false;
  const pending = testDeferred<undefined>();
  runtimes.launch(
    sessionId,
    runnerId,
    0,
    "step",
    ({ controller, restartRequest, settled }) => {
      abortState = captureAbort(controller);
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
    aborted: () => abortState?.aborted() === true,
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
      pendingTools: (sessionId) => [{ count: 1, name: `bash:${sessionId}` }],
      now: clock.now,
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

function serverRestartRequest(restartId: string): RestartRequest {
  return { boundary: "step", requestedBy: "server", restartId };
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

    await advanceDrain(clock, control, DEVELOPMENT_RESTART_LIFECYCLE_MS);

    expectForceParked(stuck);
    expect(stuck.durable()).toEqual([serverRestartRequest("restart-1")]);
    stuck.finish();
    await runtimes.cleared("session-1");
    expect(stuck.cleared()).toBe(false);
  });

  test("starts force-park persistence even while initial persistence is stalled", async () => {
    const fixture = restartRuntimeFixture();
    const initialPersistence = testDeferred<undefined>();
    const forcePersistence = testDeferred<undefined>();
    let persistenceCalls = 0;
    let abortState: Readonly<{ aborted: () => boolean }> | undefined;
    const runtime = testDeferred<undefined>();
    fixture.runtimes.launch(
      "session-stalled-persistence",
      "runner-1",
      0,
      "step",
      ({ controller, restartRequest }) => {
        abortState = captureAbort(controller);
        restartRequest((_request, _durable, forcePark) => {
          persistenceCalls += 1;
          return forcePark === true
            ? forcePersistence.promise
            : initialPersistence.promise;
        });
        return runtime.promise;
      },
    );
    const drain = fixture.control.drainServer();
    fixture.clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS);
    await waitUntil(() => persistenceCalls === 2);

    expect(abortState?.aborted()).toBe(false);
    forcePersistence.resolve(undefined);
    await Promise.resolve();
    expect(abortState?.aborted()).toBe(false);
    initialPersistence.resolve(undefined);
    await drain;
    expect(abortState?.aborted()).toBe(true);
    runtime.resolve(undefined);
  });

  test("waits for sessions that settle before the drain limit", async () => {
    const { clock, control, session: settling } = await singleSessionDrain();
    const { drained } = await startedDrain(control);
    clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS / 2);
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
    clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS);
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

  test("re-scoped runner progress starts when the server drain is abandoned", async () => {
    const fixture = pendingRunnerDrain();
    const { clock, control, runtime } = fixture;
    const runnerDrain = control.drainRunner("runner-1", "runner-restart");
    const serverDrain = control.drainServer();
    await waitUntil(() => control.drainProgress().length === 1);
    clock.advance(1_500);

    control.restoreServerDrain();

    expect(control.drainProgress()).toEqual([
      expect.objectContaining({ elapsedMs: 0, runnerId: "runner-1" }),
    ]);
    runtime.finish();
    await Promise.all([runnerDrain, serverDrain]);
  });

  test("final preparation retires a bounded runner continuation and leaves final drain unbounded", async () => {
    const { clock, control, runtime } = pendingRunnerDrain();
    const { drained: runnerDrain } = await startedDrain(control, "runner");
    await control.prepareServerShutdown();
    expect(runtime.durable()).toEqual([serverRestartRequest("restart-1")]);
    const finalDrain = control.drainServerFinal();
    clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS);

    await runnerDrain;
    let finalSettled = false;
    void finalDrain.then(() => {
      finalSettled = true;
    });
    await Promise.resolve();
    expect(finalSettled).toBe(false);
    expect(runtime.aborted()).toBe(false);

    runtime.finish();
    await finalDrain;
  });

  test("filters progress before applying the recipient session cap", () => {
    const fixture = restartRuntimeFixture();
    const { control, runtimes } = fixture;
    for (let index = 0; index < 101; index += 1) {
      pendingRuntime(runtimes, `session-${String(index).padStart(3, "0")}`);
    }
    void control.drainServer();

    expect(
      control.drainProgress(undefined, (sessionId) =>
        sessionId.endsWith("100"),
      ),
    ).toEqual([expect.objectContaining({ sessionId: "session-100" })]);
  });

  test("counts duplicate and overflowed tool invocations in progress", () => {
    const tools = Array.from({ length: 101 }, (_, index) => ({
      count: index === 0 ? 2 : 1,
      name: `tool-${String(index)}`,
    }));
    const fixture = restartRuntimeFixture();
    const control = createSessionRestartControl(
      fixture.runtimes,
      () => "restart-overflow",
      { pendingTools: () => tools },
    );
    pendingRuntime(fixture.runtimes, "session-overflow");
    void control.drainServer();

    const [progress] = control.drainProgress();
    expect(progress?.tools).toHaveLength(100);
    expect(progress?.tools[0]).toEqual({ count: 2, name: "tool-0" });
    expect(progress?.totalTools).toBe(102);
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
        tools: [{ count: 1, name: "bash:session-1" }],
        totalTools: 1,
      },
      {
        elapsedMs: 1_500,
        runnerId: "runner-2",
        sessionId: "session-2",
        tools: [{ count: 1, name: "bash:session-2" }],
        totalTools: 1,
      },
    ]);

    clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS);
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
