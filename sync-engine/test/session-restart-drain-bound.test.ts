import { describe, expect, test } from "vitest";
import { RESTART_DRAIN_LIMIT_MS } from "../../shared/development-shutdown.ts";
import { testDeferred } from "../../shared/test/promise-fixtures.ts";
import { createSessionRestartControl } from "../../sync-engine/session-restart-control.ts";
import {
  SessionRuntimes,
  type RestartRequest,
} from "../../sync-engine/session-runtime.ts";

interface PendingRuntime {
  readonly aborted: () => boolean;
  readonly cleared: () => boolean;
  readonly durable: () => readonly RestartRequest[];
  readonly finish: () => void;
}

class TestClock {
  #now = 1_000;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();
  #nextId = 1;

  readonly clearTimeout = (
    id: number | ReturnType<typeof setTimeout>,
  ): void => {
    if (typeof id === "number") {
      this.#timers.delete(id);
    }
  };

  readonly now = (): number => this.#now;

  readonly setTimeout = (callback: () => void, delay: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delay, callback });
    return id;
  };

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.#now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
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

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function testRestartControl(
  clock: TestClock,
  runtimes: SessionRuntimes,
  logged: string[] = [],
) {
  let restartId = 0;
  return createSessionRestartControl(
    runtimes,
    () => `restart-${String((restartId += 1))}`,
    {
      clearTimeout: clock.clearTimeout,
      log: (message) => logged.push(message),
      pendingTools: (sessionId) => [`bash:${sessionId}`],
      setTimeout: clock.setTimeout,
    },
  );
}

async function drainingServer(
  sessionIds: readonly (readonly [string, string])[],
  logged: string[] = [],
) {
  const clock = new TestClock();
  const runtimes = new SessionRuntimes(clock.now);
  const control = testRestartControl(clock, runtimes, logged);
  const sessions = sessionIds.map(([sessionId, runnerId]) =>
    pendingRuntime(runtimes, sessionId, runnerId),
  );
  await Promise.resolve();
  return { clock, control, runtimes, sessions };
}

// Wrapped: returning the promise itself would flatten into the awaited
// result, so the caller would block on the whole drain instead of starting it.
async function startedDrain(
  control: ReturnType<typeof testRestartControl>,
): Promise<{ readonly drained: Promise<void> }> {
  const drained = control.drainServer();
  await flush();
  return { drained };
}

async function advanceDrain(
  clock: TestClock,
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
    expect(control.drainProgress()).toEqual([]);
    expect(logged).toEqual([
      expect.stringContaining(
        "force-parked 2 session(s) still running at the restart drain limit",
      ),
    ]);
    expect(logged[0]).toContain("session-1 (bash:session-1, 122s)");
  });
});
