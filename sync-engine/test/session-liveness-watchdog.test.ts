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
  const setup = createStore();
  const detail = createTestSession(setup.store);
  expect(
    setup.store.transitionRuntime(
      detail.id,
      "running",
      TEST_NOW + 1,
      detail.generation,
    ),
  ).toBe(true);
  return { ...setup, detail };
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

test("fails a running session whose runtime disappeared beyond the grace bound", () => {
  const setup = runningSetup();
  const watchdog = watchdogSetup(setup, { graceMs: 1_000 });

  watchdog.scan();
  expect(setup.store.get(TEST_USER_ID, STORE_SESSION_ID)?.status).toBe(
    "running",
  );

  watchdog.setNow(TEST_NOW + 1_003);
  watchdog.scan();

  const failed = setup.store.get(TEST_USER_ID, STORE_SESSION_ID);
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed?.messages.at(-1)?.content).toContain(
    "liveness watchdog found no active runtime",
  );
  expect(watchdog.stopChildren).toHaveBeenCalledOnce();
  expect(watchdog.finished).toHaveBeenCalledOnce();
  expect(watchdog.notify).toHaveBeenCalledWith(TEST_USER_ID, STORE_SESSION_ID);
  setup.database.$client.close();
});

test("requires the stored execution generation to match its runtime", () => {
  const setup = runningSetup();
  const runtimes = new SessionRuntimes();
  const runtime = Promise.withResolvers<undefined>();
  expect(
    runtimes.launch(
      setup.detail.id,
      STORE_RUNNER_ID,
      setup.detail.generation + 1,
      () => runtime.promise,
    ),
  ).toBe(true);
  const watchdog = watchdogSetup(setup, { graceMs: 1_000, runtimes });

  watchdog.scan();
  watchdog.setNow(TEST_NOW + 1_003);
  watchdog.scan();

  expect(setup.store.get(TEST_USER_ID, setup.detail.id)?.status).toBe("failed");
  runtime.resolve();
  setup.database.$client.close();
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
  watchdog.setNow(TEST_NOW + 1_003);
  watchdog.scan();

  expect(setup.store.get(TEST_USER_ID, setup.detail.id)).toMatchObject({
    generation: setup.detail.generation + 1,
    restartHandoff: { restartId: "bounded-shutdown" },
    status: "paused",
  });
  expect(watchdog.finished).not.toHaveBeenCalled();
  setup.database.$client.close();
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
  setup.database.$client.close();
});

test("does not time out a twenty-minute command on a live runner connection", async () => {
  const setup = runningSetup();
  const runtimes = new SessionRuntimes();
  const runtime = Promise.withResolvers<undefined>();
  expect(
    runtimes.launch(
      setup.detail.id,
      STORE_RUNNER_ID,
      setup.detail.generation,
      () => runtime.promise,
    ),
  ).toBe(true);
  const broker = new RunnerCommandBroker({
    commandId: () => "twenty-minute-command",
    deliver: () => true,
  });
  const result = broker.dispatch({
    arguments: { command: "sleep 1200" },
    executionEnvironment: "bare_metal",
    generation: setup.detail.generation,
    runnerId: STORE_RUNNER_ID,
    sessionId: setup.detail.id,
    tool: "bash",
    workingDirectory: "/work/project",
  });
  const watchdog = watchdogSetup(setup, {
    broker,
    graceMs: 60_000,
    runtimes,
  });
  watchdog.watchdog.runnerConnected(STORE_RUNNER_ID);

  watchdog.scan();
  watchdog.setNow(TEST_NOW + 20 * 60_000);
  watchdog.scan();

  expect(setup.store.get(TEST_USER_ID, setup.detail.id)?.status).toBe(
    "running",
  );
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
  await runtimes.settled(setup.detail.id);
  setup.database.$client.close();
});
