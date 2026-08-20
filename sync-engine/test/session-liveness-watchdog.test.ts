import { expect, test, vi } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { agentSessions, runners } from "../../shared/database/schema.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import type { SessionRuntimePendingComponent } from "../../shared/session-model.ts";
import type { SessionDependencies } from "../../sync-engine/session-dependencies.ts";
import { createSessionLivenessWatchdog } from "../../sync-engine/session-liveness-scheduler.ts";
import { SessionLivenessWatchdog } from "../../sync-engine/session-liveness-watchdog.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "../../sync-engine/session-shutdown-interrupted-store.ts";
import { notifySessionSteeringInput } from "../../sync-engine/session-steering-wakeup.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { DeferredAgentModel } from "./deferred-agent-model.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import {
  awaitProviderCall,
  closeLivenessSession,
  createUnsafeLivenessSession,
  scanAfter,
  sessionDetailStatus,
  waitForCompactedSession,
  waitForIdleSession,
} from "./session-liveness-test-helpers.ts";
import { orchestrationActions } from "./session-restart-orchestration-test-helpers.ts";
import { spawnedChildSetup } from "./session-store-spawn-test-helpers.ts";
import {
  createStore,
  createTestSession,
  STORE_RUNNER_ID,
  STORE_SESSION_ID,
} from "./session-store-test-fixtures.ts";

export function runningSetup() {
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

export function closeSetup(
  setup: Pick<ReturnType<typeof createStore>, "database">,
): void {
  const database = setup.database.$client;
  database.close();
}

export function watchdogSetup(
  setup: Pick<ReturnType<typeof createStore>, "database" | "store">,
  options: {
    readonly actions?: ConstructorParameters<
      typeof SessionLivenessWatchdog
    >[0]["actions"];
    readonly allowUnsafeTestTiming?: boolean;
    readonly broker?: RunnerCommandBroker;
    readonly cleanup?: ConstructorParameters<
      typeof SessionLivenessWatchdog
    >[0]["cleanup"];
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
    actions: options.actions ?? { finished, reportAll, stopChildren },
    allowUnsafeTestTiming: options.allowUnsafeTestTiming ?? true,
    broker: options.broker ?? new RunnerCommandBroker(),
    cleanup: options.cleanup ?? vi.fn(),
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

export function launchRuntime(
  setup: ReturnType<typeof runningSetup>,
  runtimes: SessionRuntimes,
  generation: number,
  component?: SessionRuntimePendingComponent,
) {
  const deferred = Promise.withResolvers<undefined>();
  let signal: AbortSignal | undefined;
  let setPending:
    ((component: SessionRuntimePendingComponent) => void) | undefined;
  expect(
    runtimes.launch(
      setup.detail.id,
      STORE_RUNNER_ID,
      generation,
      ({ controller, pendingComponent }) => {
        signal = controller.signal;
        setPending = pendingComponent;
        if (component !== undefined) pendingComponent(component);
        return component === "provider_admission"
          ? new Promise<never>((_resolve, reject) => {
              const rejectAbort = () => {
                reject(
                  new DOMException("The session was aborted", "AbortError"),
                );
              };
              controller.signal.addEventListener("abort", rejectAbort, {
                once: true,
              });
            })
          : deferred.promise;
      },
    ),
  ).toBe(true);
  return {
    ...deferred,
    pending: (pending: SessionRuntimePendingComponent) => {
      setPending?.(pending);
    },
    get signal() {
      return signal;
    },
  };
}

function launchPendingRuntime(
  setup: ReturnType<typeof runningSetup>,
  component: SessionRuntimePendingComponent,
) {
  const runtimes = new SessionRuntimes(() => Date.now());
  const runtime = launchRuntime(
    setup,
    runtimes,
    setup.detail.generation,
    component,
  );
  if (runtime.signal === undefined) {
    throw new Error("The pending runtime signal was unavailable");
  }
  return { ...runtime, runtimes };
}

function admissionWatchdogSetup() {
  const setup = runningSetup();
  const runtime = launchPendingRuntime(setup, "provider_admission");
  const watchdog = watchdogSetup(setup, {
    graceMs: 1_000,
    runtimes: runtime.runtimes,
  });
  return { runtime, setup, watchdog };
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

function expectRuntimeRemainsActive(
  setup: ReturnType<typeof runningSetup>,
  runtime: ReturnType<typeof launchPendingRuntime>,
): void {
  expectStoredStatus(setup, "running");
  expect(runtime.signal).toMatchObject({ aborted: false });
  runtime.resolve();
  closeSetup(setup);
}

function schedulerSetup(liveness?: SessionDependencies["liveness"]) {
  const setup = runningSetup();
  const create = () =>
    createSessionLivenessWatchdog({
      actions: {
        finished: vi.fn(),
        reportAll: vi.fn(),
        stopChildren: vi.fn(),
      },
      broker: new RunnerCommandBroker(),
      cleanup: vi.fn(),
      database: setup.database,
      dependencies: {
        braveSearch: { execute: () => Promise.resolve("unused") },
        ...(liveness === undefined ? {} : { liveness }),
      },
      notify: vi.fn(),
      now: () => TEST_NOW,
      runtimes: new SessionRuntimes(),
      shutdownInterrupted: new ShutdownInterruptedSessionStore({
        database: setup.database,
        generateId: () => "scheduler-handoff-message",
      }),
      store: setup.store,
    });
  return { create, setup };
}

function expectSchedulerError(
  liveness: NonNullable<SessionDependencies["liveness"]>,
  message: string,
): void {
  const { create, setup } = schedulerSetup(liveness);
  expect(create).toThrow(message);
  closeSetup(setup);
}

test("stops the default global scan interval", () => {
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  try {
    const { create, setup } = schedulerSetup();
    const liveness = create();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    const timer: unknown = setIntervalSpy.mock.results[0]?.value;
    liveness.stop();
    liveness.stop();
    const timerClears = clearIntervalSpy.mock.calls.filter(
      ([cleared]) => cleared === timer,
    );
    expect(timerClears).toHaveLength(1);
    closeSetup(setup);
  } finally {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  }
});

test("stops an injected scan interval once across repeated shutdowns", async () => {
  const cleared: unknown[] = [];
  const setup = connectedSessionSetup(
    new DeferredAgentModel(),
    "api_key",
    undefined,
    {
      liveness: {
        clearInterval: (timer) => cleared.push(timer),
        setInterval: () => "liveness-timer",
      },
    },
  );
  await setup.sessions.prepareFinalShutdown();
  await setup.sessions.prepareFinalShutdown();
  expect(cleared).toEqual(["liveness-timer"]);
  closeLivenessSession(setup);
});

test("rejects a below-floor grace outside the explicit test bypass", () => {
  const setup = runningSetup();

  expect(() =>
    watchdogSetup(setup, {
      allowUnsafeTestTiming: false,
      graceMs: 1_000,
    }),
  ).toThrow("at least 60000 ms");
  closeSetup(setup);
});

test("rejects a below-floor production scan interval", () => {
  expectSchedulerError(
    { graceMs: 60_000, intervalMs: 9_999 },
    "interval must be at least 10000 ms",
  );
});

test("rejects a production scan interval longer than its grace", () => {
  expectSchedulerError(
    { graceMs: 60_000, intervalMs: 60_001 },
    "interval must not exceed the grace period",
  );
});

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

test("allows legitimate provider retries to refresh the admission bound", () => {
  const admission = admissionWatchdogSetup();
  const { runtime, setup, watchdog } = admission;

  watchdog.scan();
  for (let minute = 1; minute <= 12; minute += 1) {
    watchdog.setNow(TEST_NOW + minute * 60_000);
    runtime.pending("provider_admission");
    watchdog.scan();
  }

  expectRuntimeRemainsActive(setup, runtime);
});

test("fails provider admission that remains unacknowledged beyond the grace bound", () => {
  const { runtime, setup, watchdog } = admissionWatchdogSetup();

  scanPastGrace(watchdog);

  expectStoredStatus(setup, "failed");
  expect(
    setup.store.get(TEST_USER_ID, setup.detail.id)?.messages.at(-1)?.content,
  ).toContain("provider request was not acknowledged");
  expect(
    setup.store.get(TEST_USER_ID, setup.detail.id)?.runtimePending,
  ).toBeNull();
  expect(runtime.signal).toMatchObject({ aborted: true });
  closeSetup(setup);
});

test("does not time out an acknowledged provider request", () => {
  const setup = runningSetup();
  const activeProvider = launchPendingRuntime(setup, "provider_request");
  const watchdog = watchdogSetup(setup, {
    graceMs: 1_000,
    runtimes: activeProvider.runtimes,
  });

  scanPastGrace(watchdog, 20 * 60_000);

  expectStoredStatus(setup, "running");
  activeProvider.resolve();
  closeSetup(setup);
});

test("preserves early acknowledgement", () => {
  const { runtime, setup, watchdog } = admissionWatchdogSetup();

  watchdog.scan();
  watchdog.setNow(TEST_NOW + 999);
  runtime.pending("provider_request");
  watchdog.scan();
  watchdog.setNow(TEST_NOW + 20 * 60_000);
  watchdog.scan();

  expectRuntimeRemainsActive(setup, runtime);
});

test("fails a queued runner command even when its runner recently connected", async () => {
  const setup = runningSetup();
  const runtime = launchPendingRuntime(setup, "startup");
  const broker = new RunnerCommandBroker({
    commandId: () => "undispatched-command",
  });
  const queuedCommand = dispatchBash(setup, broker);
  const watchdog = watchdogSetup(setup, {
    runtimes: runtime.runtimes,
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

function parentCallbackCount(setup: ReturnType<typeof spawnedChildSetup>) {
  const parent = setup.store.get(TEST_USER_ID, setup.parentId);
  return [
    ...(parent?.pendingInputs.map(({ content }) => content) ?? []),
    ...(parent?.messages.map(({ content }) => content) ?? []),
  ].filter(
    (content) =>
      content.includes("Spawned session completed") ||
      content.includes("Spawned session failed"),
  ).length;
}

function pendingCallbacksAreDelivered(
  setup: ReturnType<typeof spawnedChildSetup>,
): void {
  expect(parentCallbackCount(setup)).toBe(1);
  expect(setup.store.pendingSpawnedSessions()).toEqual([]);
}

test("two real scans deliver a pending child callback exactly once", () => {
  const setup = spawnedChildSetup();
  const actions = orchestrationActions(setup.database, setup.store);
  const watchdog = watchdogSetup(setup, { actions });

  watchdog.scan();
  watchdog.scan();

  pendingCallbacksAreDelivered(setup);
  closeSetup(setup);
});

test("a watchdog-failed child reports failure to its parent exactly once", () => {
  const setup = spawnedChildSetup();
  setup.database.$client
    .query("UPDATE agent_sessions SET status = 'running' WHERE id = ?")
    .run(setup.childId);
  const actions = orchestrationActions(setup.database, setup.store);
  const runtimes = new SessionRuntimes();
  const parentRuntime = Promise.withResolvers<undefined>();
  expect(
    runtimes.launch(
      setup.parentId,
      STORE_RUNNER_ID,
      setup.parentGeneration,
      () => parentRuntime.promise,
    ),
  ).toBe(true);
  const watchdog = watchdogSetup(setup, {
    actions,
    graceMs: 1_000,
    runtimes,
  });

  scanPastGrace(watchdog);
  watchdog.scan();

  expect(setup.store.get(TEST_USER_ID, setup.childId)?.status).toBe("failed");
  pendingCallbacksAreDelivered(setup);
  parentRuntime.resolve(undefined);
  closeSetup(setup);
});

async function deferredLivenessSession() {
  const model = new DeferredAgentModel();
  return { model, ...(await createUnsafeLivenessSession(model)) };
}

test("compacts an opted-in idle session after a liveness scan", async () => {
  const run = await deferredLivenessSession();
  const { clock, setup } = run;
  const restDuration = 30 * 60_000 + 1_000;
  run.model.resolveContent("Initial run complete.");
  await waitForIdleSession(setup);
  setup.database
    .update(agentSessions)
    .set({
      currentContextTokens: 5_000,
      idleCompact: true,
      updatedAt: new Date(TEST_NOW),
    })
    .run();
  // Thirty minutes pass for the session, not the runner: keep its
  // heartbeat fresh so queueing sees an available runner.
  setup.database
    .update(runners)
    .set({ lastSeenAt: new Date(clock.now() + restDuration) })
    .run();

  // The idle scheduler rides the liveness cadence: thirty minutes of rest
  // plus one scan must compact without any other trigger, proving the
  // afterScan seam is actually wired.
  scanAfter(clock, restDuration);

  await waitForCompactedSession(setup);
  closeLivenessSession(setup);
});

test("does not time out a provider-call-only runtime", async () => {
  const { clock, model, setup } = await deferredLivenessSession();
  await awaitProviderCall(model.requests);

  scanAfter(clock, 20 * 60_000);

  const running = sessionDetailStatus(setup);
  expect(running).toBe("running");
  model.resolveContent("Provider call completed.");
  await waitForIdleSession(setup);
  closeLivenessSession(setup);
});

test("does not time out an engine-side sleep", async () => {
  let requestCount = 0;
  const model: AgentModel = {
    complete: () => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? providerStep("Sleeping in the engine.", {
              toolCalls: [toolCall("sleep", { durationSeconds: 60 })],
            })
          : providerStep("Awake after steering."),
      );
    },
  };
  const { clock, setup } = await createUnsafeLivenessSession(model);
  await waitForSessionValue(
    () =>
      JSON.stringify(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)),
    (detail) =>
      typeof detail === "string" && detail.includes("Sleeping in the engine."),
  );

  scanAfter(clock, 20 * 60_000);

  expect(sessionDetailStatus(setup, SESSION_ID)).toBe("running");
  notifySessionSteeringInput(SESSION_ID);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status,
    (status) => status === "idle",
  );
  closeLivenessSession(setup);
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
