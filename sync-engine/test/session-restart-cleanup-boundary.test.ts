import { expect, test } from "vitest";
import { RestartDeadline } from "../../shared/restart-deadline.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { SessionExecutionCleanup } from "../../sync-engine/session-execution-cleanup.ts";
import { createSessionRestartControl } from "../../sync-engine/session-restart-control.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";

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

function drainExpired(cleanup: SessionExecutionCleanup): Promise<void> {
  return cleanup.drainPending(new RestartDeadline(0, () => 0));
}

async function pendingCleanup() {
  const dispatched = Promise.withResolvers<undefined>();
  const brokerOptions: ConstructorParameters<typeof RunnerCommandBroker>[0] = {
    commandId: () => "cleanup-command",
    deliver: (_runnerId, command) => {
      if (command.tool === RUNNER_EXECUTION_CLEANUP_COMMAND) {
        dispatched.resolve(undefined);
      }
      return true;
    },
  };
  const broker = new RunnerCommandBroker(brokerOptions);
  const cleanup = new SessionExecutionCleanup(broker);
  const promise = containerCleanup(cleanup);
  await dispatched.promise;
  return { broker, cleanup, promise };
}

function pendingCleanupWithBroker() {
  return pendingCleanup();
}

test("development restart cancels pending execution cleanup without waiting", async () => {
  const { broker, cleanup, promise } = await pendingCleanup();
  const runtimes = new SessionRuntimes();
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
  const { broker, cleanup, promise } = await pendingCleanupWithBroker();
  const terminal = cleanup.cleanupTerminal({
    ...TEST_SESSION_DETAIL,
    executionEnvironment: "container",
  });

  await drainExpired(cleanup);
  await promise;
  await terminal;

  expectCleanupInactive(broker);
});

test("final shutdown can still await pending execution cleanup", async () => {
  const { broker, promise } = await pendingCleanup();
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  expect(
    broker.complete(TEST_SESSION_DETAIL.runnerId, "cleanup-command", {
      output: "cleaned",
      state: "completed",
    }),
  ).toBe(true);
  await promise;
  expect(settled).toBe(true);
});
