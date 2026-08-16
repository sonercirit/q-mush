import { expect, test } from "vitest";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { SessionExecutionCleanup } from "../../sync-engine/session-execution-cleanup.ts";
import { createSessionRestartControl } from "../../sync-engine/session-restart-control.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";

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
  const promise = cleanup.cleanup({
    ...TEST_SESSION_DETAIL,
    executionEnvironment: "container",
  });
  await dispatched.promise;
  return { broker, cleanup, promise };
}

test("development restart cancels pending execution cleanup without waiting", async () => {
  const { broker, cleanup, promise } = await pendingCleanup();
  const runtimes = new SessionRuntimes();
  const restart = createSessionRestartControl(
    runtimes,
    () => "restart-cleanup",
  );

  await restart.drainServer();
  const draining = cleanup.drainPending(0);

  await draining;
  await expect(promise).resolves.toBeUndefined();
  expect(broker.isActive(TEST_SESSION_DETAIL.runnerId, "cleanup-command")).toBe(
    false,
  );
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
