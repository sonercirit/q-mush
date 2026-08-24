import { expect, onTestFinished, test, vi } from "vitest";
import { createRestartDeadline } from "../../shared/restart-deadline.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  createRunnerCommandBroker,
  type RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createSessionExecutionCleanup,
  type SessionExecutionCleanup,
} from "../../sync-engine/session-execution-cleanup.ts";
import { createSessionRestartControl } from "../../sync-engine/session-restart-control.ts";
import { createSessionRuntimes } from "../../sync-engine/session-runtime.ts";

function expectCleanupInactive(broker: RunnerCommandBroker): void {
  expect(broker.isActive(TEST_SESSION_DETAIL.runnerId, "cleanup-command")).toBe(
    false,
  );
}

function containerCleanup(cleanup: SessionExecutionCleanup): Promise<void> {
  return cleanup.cleanup({
    ...TEST_SESSION_DETAIL,
    executionEnvironment: "container",
  });
}

function finishCleanupCommand(
  broker: RunnerCommandBroker,
  commandId: string,
): void {
  expectCleanupInactive(broker);
  expect(commandId).toBe("cleanup-command");
}

function completeCleanup(
  broker: RunnerCommandBroker,
  commandId = "cleanup-command",
): void {
  expect(
    broker.complete(TEST_SESSION_DETAIL.runnerId, commandId, {
      output: "cleaned",
      state: "completed",
    }),
  ).toBe(true);
}

function drainExpired(cleanup: SessionExecutionCleanup): Promise<void> {
  return cleanup.drainPending(createRestartDeadline(0, () => 0));
}

async function pendingCleanup() {
  const dispatched = Promise.withResolvers<undefined>();
  const brokerOptions: Parameters<typeof createRunnerCommandBroker>[0] = {
    commandId: () => "cleanup-command",
    deliver: (_runnerId, command) => {
      if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
        dispatched.resolve(undefined);
      }
      return true;
    },
  };
  const broker = createRunnerCommandBroker(brokerOptions);
  const cleanup = createSessionExecutionCleanup(broker);
  const promise = containerCleanup(cleanup);
  await dispatched.promise;
  return { broker, cleanup, promise };
}

test("development restart cancels pending execution cleanup without waiting", async () => {
  const { broker, cleanup, promise } = await pendingCleanup();
  const runtimes = createSessionRuntimes();
  const restart = createSessionRestartControl(
    runtimes,
    () => "restart-cleanup",
  );

  await restart.drainServer();
  const draining = drainExpired(cleanup);

  await draining;
  await expect(promise).resolves.toBeUndefined();
  finishCleanupCommand(broker, "cleanup-command");
});

test("development drain prevents chained terminal cleanup from dispatching", async () => {
  const pending = await pendingCleanup();
  const { broker, cleanup, promise } = pending;
  const terminal = cleanup.cleanupTerminal({
    ...TEST_SESSION_DETAIL,
    executionEnvironment: "container",
  });

  await drainExpired(cleanup);
  await promise;
  await terminal;

  expectCleanupInactive(broker);
});

test("overlapping drains suppress cleanup until every drain settles", async () => {
  const timers: (() => void)[] = [];
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (callback: () => void) => {
      timers.push(callback);
      return originalSetTimeout(() => undefined, 1_000_000);
    },
  );
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
  let commandSequence = 0;
  const broker = createRunnerCommandBroker({
    commandId: () => `cleanup-${String(++commandSequence)}`,
    deliver: () => true,
  });
  // Keep cancellation inert so the first cleanup remains pending while each
  // drain deadline is advanced independently.
  vi.spyOn(broker, "cancelSessionCommands").mockReturnValue([]);
  const cleanup = createSessionExecutionCleanup(broker);
  const first = containerCleanup(cleanup);
  const shortDrain = cleanup.drainPending(createRestartDeadline(20, () => 0));
  const longDrain = cleanup.drainPending(createRestartDeadline(100, () => 0));

  expect(timers).toHaveLength(2);
  timers[0]?.();
  await shortDrain;
  const suppressedDetail = {
    ...TEST_SESSION_DETAIL,
    id: "suppressed-cleanup",
  };
  await cleanup.cleanupTerminal(suppressedDetail);
  expect(broker.isActive(TEST_SESSION_DETAIL.runnerId, "cleanup-2")).toBe(
    false,
  );

  timers[1]?.();
  await longDrain;
  const resumedDetail = { ...TEST_SESSION_DETAIL, id: "resumed-cleanup" };
  const resumed = cleanup.cleanupTerminal(resumedDetail);
  expect(broker.isActive(TEST_SESSION_DETAIL.runnerId, "cleanup-2")).toBe(true);
  completeCleanup(broker, "cleanup-2");
  await resumed;
  await first;
});

test("cleanup dispatch resumes after a completed development drain", async () => {
  const broker = createRunnerCommandBroker({
    commandId: () => "cleanup-command",
    deliver: () => true,
  });
  const cleanup = createSessionExecutionCleanup(broker);

  await drainExpired(cleanup);
  const promise = containerCleanup(cleanup);

  expect(broker.isActive(TEST_SESSION_DETAIL.runnerId, "cleanup-command")).toBe(
    true,
  );
  completeCleanup(broker);
  await promise;
});

test("final shutdown can still await pending execution cleanup", async () => {
  const { broker, promise } = await pendingCleanup();
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  completeCleanup(broker);
  await promise;
  expect(settled).toBe(true);
});
