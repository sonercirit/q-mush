import { expect, test, vi } from "vitest";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { SessionLivenessWatchdog } from "../../sync-engine/session-liveness-watchdog.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "../../sync-engine/session-shutdown-interrupted-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { spawnedChildSetup } from "./session-store-spawn-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_RUNNER_ID,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

function runningSetup() {
  const { database, generateId, store } = createStore();
  const detail = createTestSession(store);
  const running = store.transitionCurrent(
    STORE_SESSION_ID,
    "running",
    TEST_NOW + 1,
  );
  expect(running).toBe(true);
  return { database, detail, generateId, store };
}

function closeSetup(
  setup: Pick<ReturnType<typeof createStore>, "database">,
): void {
  setup.database.$client.close();
}

function watchdogSetup(
  setup: Pick<ReturnType<typeof createStore>, "database" | "store">,
  options: {
    readonly broker?: RunnerCommandBroker;
    readonly graceMs?: number;
    readonly runtimes?: SessionRuntimes;
  } = {},
) {
  let now = TEST_NOW + 2;
  const finished = vi.fn();
  const notify = vi.fn();
  const reportAll = vi.fn();
  const stopChildren = vi.fn();
  const shutdownInterrupted = new ShutdownInterruptedSessionStore({
    database: setup.database,
    generateId: () => "watchdog-handoff-message",
  });
  const watchdog = new SessionLivenessWatchdog({
    actions: { finished, reportAll, stopChildren },
    broker: options.broker ?? new RunnerCommandBroker(),
    database: setup.database,
    generateId: () => "watchdog-failure-message",
    graceMs: options.graceMs ?? 60_000,
    notify,
    now: () => now,
    runtimes: options.runtimes ?? new SessionRuntimes(),
    shutdownInterrupted,
    store: setup.store,
  });
  return {
    finished,
    notify,
    reportAll,
    scan: () => {
      watchdog.scan();
    },
    setNow: (value: number) => {
      now = value;
    },
    shutdownInterrupted,
    stopChildren,
    watchdog,
  };
}

function scanPastGrace(
  watchdog: ReturnType<typeof watchdogSetup>,
  elapsedMs = 1_003,
): void {
  watchdog.scan();
  watchdog.setNow(TEST_NOW + elapsedMs);
  watchdog.scan();
}

function launchRuntime(
  setup: ReturnType<typeof runningSetup>,
  runtimes: SessionRuntimes,
  generation: number,
) {
  const deferred = Promise.withResolvers<undefined>();
  expect(
    runtimes.launch(
      setup.detail.id,
      STORE_RUNNER_ID,
      generation,
      () => deferred.promise,
    ),
  ).toBe(true);
  return deferred;
}

function dispatchBash(
  setup: ReturnType<typeof runningSetup>,
  broker: RunnerCommandBroker,
) {
  return broker.dispatch({
    arguments: { command: "sleep 1200" },
    executionEnvironment: "bare_metal",
    generation: setup.detail.generation,
    runnerId: STORE_RUNNER_ID,
    sessionId: setup.detail.id,
    tool: "bash",
    workingDirectory: "/work/project",
  });
}

function expectStoredStatus(
  setup: ReturnType<typeof runningSetup>,
  expected: string,
): void {
  const status = setup.store.get(TEST_USER_ID, setup.detail.id)?.status;
  expect(status).toBe(expected);
}

test("fails a running session whose runtime disappeared beyond the grace bound", () => {
  const setup = runningSetup();
  const liveness = watchdogSetup(setup, { graceMs: 1_000 });

  scanPastGrace(liveness);

  const failed = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed?.messages.at(-1)?.content).toContain(
    "liveness watchdog found no active runtime",
  );
  expect(liveness.stopChildren).toHaveBeenCalledOnce();
  expect(liveness.finished).toHaveBeenCalledOnce();
  expect(liveness.notify).toHaveBeenCalledWith(TEST_USER_ID, STORE_SESSION_ID);
  closeSetup(setup);
});

test("requires the stored execution generation to match its runtime", () => {
  const setup = runningSetup();
  const staleRuntimes = new SessionRuntimes();
  const runtime = launchRuntime(
    setup,
    staleRuntimes,
    setup.detail.generation + 1,
  );
  const watchdog = watchdogSetup(setup, {
    graceMs: 1_000,
    runtimes: staleRuntimes,
  });

  scanPastGrace(watchdog);

  expectStoredStatus(setup, "failed");
  runtime.resolve();
  closeSetup(setup);
});

test("fails a queued runner command even when its runner recently connected", async () => {
  const setup = runningSetup();
  const runtimes = new SessionRuntimes();
  const runtime = launchRuntime(setup, runtimes, setup.detail.generation);
  const broker = new RunnerCommandBroker({
    commandId: () => "undispatched-command",
  });
  const queuedCommand = dispatchBash(setup, broker);
  const watchdog = watchdogSetup(setup, {
    runtimes,
    graceMs: 1_000,
    broker,
  });
  watchdog.watchdog.runnerConnected(STORE_RUNNER_ID);

  scanPastGrace(watchdog);

  expectStoredStatus(setup, "failed");
  await expect(queuedCommand).rejects.toThrow("stopped");
  runtime.resolve();
  closeSetup(setup);
});

test("recovers a durable shutdown marker instead of failing its session", () => {
  const setup = runningSetup();
  const watchdog = watchdogSetup(setup, { graceMs: 1_000 });
  expect(
    watchdog.shutdownInterrupted.mark(
      setup.detail.id,
      setup.detail.generation,
      "bounded-shutdown",
      "agent",
      TEST_NOW + 2,
    ),
  ).toBe(true);

  watchdog.scan();

  const recovered = setup.store.get(TEST_USER_ID, setup.detail.id);
  expect(recovered).toMatchObject({
    generation: setup.detail.generation + 1,
    restartHandoff: { restartId: "bounded-shutdown" },
    status: "paused",
  });
  expect(watchdog.finished).not.toHaveBeenCalled();
  closeSetup(setup);
});

test("retries pending completed-child callback delivery on every scan", () => {
  const setup = spawnedChildSetup();
  const watchdog = watchdogSetup(setup);

  watchdog.scan();

  expect(watchdog.reportAll).toHaveBeenCalledOnce();
  const pending: unknown = watchdog.reportAll.mock.calls[0]?.[0];
  expect(pending).toMatchObject([
    {
      detail: { id: setup.childId },
      userId: TEST_USER_ID,
    },
  ]);
  closeSetup(setup);
});

test("does not time out a twenty-minute command on a live runner connection", async () => {
  const setup = runningSetup();
  const currentRuntimes = new SessionRuntimes();
  const runtime = launchRuntime(
    setup,
    currentRuntimes,
    setup.detail.generation,
  );
  const broker = new RunnerCommandBroker({
    commandId: () => "twenty-minute-command",
    deliver: () => true,
  });
  const result = dispatchBash(setup, broker);
  const watchdog = watchdogSetup(setup, {
    broker,
    graceMs: 60_000,
    runtimes: currentRuntimes,
  });
  watchdog.watchdog.runnerConnected(STORE_RUNNER_ID);

  const twentyMinutesLater = TEST_NOW + 20 * 60_000;
  watchdog.scan();
  watchdog.setNow(twentyMinutesLater);
  watchdog.scan();

  const statusAfterTwentyMinutes = setup.store.get(
    TEST_USER_ID,
    setup.detail.id,
  )?.status;
  expect(statusAfterTwentyMinutes).toBe("running");
  expect(broker.isActive(STORE_RUNNER_ID, "twenty-minute-command")).toBe(true);
  expect(watchdog.notify).not.toHaveBeenCalled();

  expect(
    broker.complete(STORE_RUNNER_ID, "twenty-minute-command", {
      output: "done",
      state: "completed",
    }),
  ).toBe(true);
  await expect(result).resolves.toMatchObject({ output: "done" });
  runtime.resolve();
  await currentRuntimes.settled(setup.detail.id);
  closeSetup(setup);
});
