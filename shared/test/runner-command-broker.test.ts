import { describe, expect, test, vi } from "vitest";
import {
  RunnerCommandBroker,
  RunnerDisconnectedError,
  type RunnerCommandResult,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { captureBrokerRejection } from "./promise-test-helpers.ts";
import {
  brokerRunnerCommand,
  completedRunnerCommand,
  deliveredBroker,
  deliveredDispatch,
  deliverQueuedRunnerCommands,
  expectBrokerInactive,
  expectCommandComplete,
  expectRunnerCommandAbort,
  expectUnauthorizedRunnerCommand,
  failingCleanupController,
  failListenerCleanup,
  revocableRunnerDispatch,
  streamedDispatch,
  TEST_RUNNER_ID,
  TEST_SESSION_ID,
  type StreamedDispatch,
} from "./runner-command-broker-fixtures.ts";

const RUNNER_ID = TEST_RUNNER_ID;
const SESSION_ID = TEST_SESSION_ID;

async function cancelAndExpectUnauthorized(
  broker: RunnerCommandBroker,
  result: Promise<RunnerCommandResult>,
): Promise<void> {
  broker.cancelSession(SESSION_ID);
  await expectUnauthorizedRunnerCommand(result);
}

function expectRejectedCompletion(
  broker: RunnerCommandBroker,
  commandId: string,
): void {
  expect(
    broker.complete(RUNNER_ID, commandId, completedRunnerCommand("late")),
  ).toBe(false);
}

async function expectCompletedResult(
  broker: RunnerCommandBroker,
  result: Promise<RunnerCommandResult>,
  commandId: string,
  output: string,
): Promise<void> {
  expectCommandComplete(broker, commandId, output);
  await expect(result).resolves.toEqual(completedRunnerCommand(output));
}

function cleanupStreamedDispatch(commandId: string): StreamedDispatch {
  return streamedDispatch(commandId, failingCleanupController().signal);
}

async function revokedReconnectDelivery(
  commandId: string,
  requeue: boolean,
): Promise<readonly string[]> {
  const delivered: RunnerToolCommand[] = [];
  const dispatch = revocableRunnerDispatch(commandId);
  if (requeue) {
    deliverQueuedRunnerCommands(dispatch.broker, delivered, false);
  }
  dispatch.revoke();
  deliverQueuedRunnerCommands(dispatch.broker, delivered, true);
  await expectUnauthorizedRunnerCommand(dispatch.result);
  expect(dispatch.broker.take(RUNNER_ID)).toBeUndefined();
  return delivered.map(({ id }) => id);
}

async function dispatchedCancellation(
  broker: RunnerCommandBroker,
): Promise<void> {
  await cancelAndExpectUnauthorized(
    broker,
    broker.dispatch(brokerRunnerCommand()),
  );
}

async function expectCanceledCommand(
  delivered: boolean,
  commandId: string,
): Promise<readonly string[]> {
  const canceled: string[] = [];
  const broker = delivered
    ? deliveredBroker(commandId, {
        cancel: (_runnerId, canceledId) => canceled.push(canceledId),
      })
    : new RunnerCommandBroker({
        cancel: (_runnerId, canceledId) => canceled.push(canceledId),
        commandId: () => commandId,
      });
  await dispatchedCancellation(broker);
  return canceled;
}

test("cancels only commands from a revoked execution generation", async () => {
  const canceled: string[] = [];
  let id = 0;
  const broker = new RunnerCommandBroker({
    cancel: (_runnerId, commandId) => canceled.push(commandId),
    commandId: () => `generation-${String(++id)}`,
    deliver: () => true,
  });
  const old = broker.dispatch(brokerRunnerCommand({ generation: 3 }));
  const current = broker.dispatch(brokerRunnerCommand({ generation: 4 }));

  expect(broker.cancelSessionGeneration(SESSION_ID, 3)).toHaveLength(1);
  expectRunnerCommandAbort(await captureBrokerRejection(old));
  expect(canceled).toEqual(["generation-1"]);
  expect(
    broker.complete(
      RUNNER_ID,
      "generation-2",
      completedRunnerCommand("current"),
    ),
  ).toBe(true);
  expect(await current).toEqual(completedRunnerCommand("current"));
});

test("delivers a command immediately when a runner socket is connected", async () => {
  const delivered: unknown[] = [];
  const broker = new RunnerCommandBroker({
    commandId: () => "websocket-command",
    deliver: (runnerId, command) => {
      delivered.push({ command, runnerId });
      return true;
    },
  });
  const result = broker.dispatch(brokerRunnerCommand());

  expect(delivered).toEqual([
    {
      command: {
        arguments: {},
        executionEnvironment: "bare_metal",
        id: "websocket-command",
        sessionId: SESSION_ID,
        tool: "bash",
        workingDirectory: "/work/project",
      },
      runnerId: RUNNER_ID,
    },
  ]);
  expect(broker.take(RUNNER_ID)).toBeUndefined();
  expect(
    broker.complete(
      RUNNER_ID,
      "websocket-command",
      completedRunnerCommand("done"),
    ),
  ).toBe(true);
  expect(await result).toEqual(completedRunnerCommand("done"));
});

test("pushes cancellation for an in-flight WebSocket command", async () => {
  expect(await expectCanceledCommand(true, "cancel-websocket-command")).toEqual(
    ["cancel-websocket-command"],
  );
});

describe("runner command broker", () => {
  test("rejects a queued command when authorization is revoked before take", async () => {
    const dispatch = revocableRunnerDispatch("revoked-take");

    dispatch.revoke();

    expect(dispatch.broker.take(RUNNER_ID)).toBeUndefined();
    await expectUnauthorizedRunnerCommand(dispatch.result);
    expectRejectedCompletion(dispatch.broker, "revoked-take");
  });

  test("rejects a queued command when authorization is revoked before reconnect delivery", async () => {
    expect(await revokedReconnectDelivery("revoked-delivery", false)).toEqual(
      [],
    );
  });

  test("reauthorizes a command requeued after failed reconnect delivery", async () => {
    expect(await revokedReconnectDelivery("requeued-delivery", true)).toEqual([
      "requeued-delivery",
    ]);
  });

  test("reauthorizes immediately before immediate delivery", async () => {
    let authorizationChecks = 0;
    const delivered: RunnerToolCommand[] = [];
    const broker = new RunnerCommandBroker({
      commandId: () => "immediate-boundary",
      deliver: (_runnerId, command) => {
        delivered.push(command);
        return true;
      },
    });
    const result = broker.dispatch(
      brokerRunnerCommand({
        authorize: () => {
          authorizationChecks += 1;
          return authorizationChecks < 3;
        },
      }),
    );

    expect(delivered).toEqual([]);
    expect(authorizationChecks).toBe(3);
    await expectUnauthorizedRunnerCommand(result);
  });

  test("cancels a revoked in-flight command and rejects its completion", async () => {
    const canceled: string[] = [];
    const dispatch = revocableRunnerDispatch("revoked-in-flight", {
      cancel: (_runnerId, commandId) => canceled.push(commandId),
      deliver: () => true,
    });

    dispatch.revoke();

    expect(
      dispatch.broker.complete(
        RUNNER_ID,
        "revoked-in-flight",
        completedRunnerCommand("late"),
      ),
    ).toBe(false);
    expect(canceled).toEqual(["revoked-in-flight"]);
    await expectUnauthorizedRunnerCommand(dispatch.result);
    expect(dispatch.broker.isActive(RUNNER_ID, "revoked-in-flight")).toBe(
      false,
    );
  });

  test("rejects in-flight commands and fences late results when the authoritative runner disconnects", async () => {
    const { broker, result } = deliveredDispatch("disconnected-command");

    broker.disconnectRunner(RUNNER_ID);

    await expect(result).rejects.toBeInstanceOf(RunnerDisconnectedError);
    expectRejectedCompletion(broker, "disconnected-command");
  });

  test("leaves queued commands for an authoritative reconnect", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "queued-through-disconnect",
    });
    const result = broker.dispatch(brokerRunnerCommand());

    broker.disconnectRunner(RUNNER_ID);

    expect(broker.take(RUNNER_ID)?.id).toBe("queued-through-disconnect");
    await expectCompletedResult(
      broker,
      result,
      "queued-through-disconnect",
      "reconnected",
    );
  });

  test("fences results from a removed runner", async () => {
    const { broker, result } = deliveredDispatch("removed-command");

    const removed = broker.runnerRemoved(RUNNER_ID);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.command.id).toBe("removed-command");
    expectRunnerCommandAbort(removed[0]?.error);
    const rejection = await captureBrokerRejection(result);
    expectRunnerCommandAbort(rejection);
    expect(rejection).toBe(removed[0]?.error);
    expectRejectedCompletion(broker, "removed-command");
  });

  test("streams only contiguous in-flight output and isolates callback errors", async () => {
    const { broker, result, streamed } = streamedDispatch(
      "streamed-command",
      undefined,
      (delta) => {
        if (delta.sequence === 1) {
          throw new Error("observational callback failed");
        }
      },
    );

    expect(
      broker.stream(RUNNER_ID, "streamed-command", {
        channel: "stdout",
        content: "one",
        sequence: 0,
      }),
    ).toBe(true);
    expect(
      broker.stream(RUNNER_ID, "streamed-command", {
        channel: "stderr",
        content: "gap",
        sequence: 2,
      }),
    ).toBe(false);
    expect(
      broker.stream(RUNNER_ID, "streamed-command", {
        channel: "stderr",
        content: "two",
        sequence: 1,
      }),
    ).toBe(true);
    expectCommandComplete(broker, "streamed-command", "canonical output");
    expect(
      broker.stream(RUNNER_ID, "streamed-command", {
        channel: "stdout",
        content: "late",
        sequence: 2,
      }),
    ).toBe(false);

    expect(streamed).toEqual([
      { channel: "stdout", content: "one", sequence: 0 },
      { channel: "stderr", content: "two", sequence: 1 },
    ]);
    await expect(result).resolves.toEqual(
      completedRunnerCommand("canonical output"),
    );
  });

  test("does not accept output while a command remains queued", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "queued-stream-command",
    });
    const result = broker.dispatch(brokerRunnerCommand(), undefined, () => {
      throw new Error("queued output must not be observed");
    });

    expect(
      broker.stream(RUNNER_ID, "queued-stream-command", {
        channel: "stdout",
        content: "early",
        sequence: 0,
      }),
    ).toBe(false);
    expect(
      broker.complete(
        RUNNER_ID,
        "queued-stream-command",
        completedRunnerCommand("early"),
      ),
    ).toBe(false);
    expect(broker.take(RUNNER_ID)?.id).toBe("queued-stream-command");
    await expectCompletedResult(
      broker,
      result,
      "queued-stream-command",
      "finished",
    );
  });

  test("does not deliver when the signal aborts while subscribing", async () => {
    const controller = new AbortController();
    const delivered: unknown[] = [];
    const originalAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = (
      type: "abort",
      listener: (this: AbortSignal, event: Event) => unknown,
      options?: AddEventListenerOptions | boolean,
    ) => {
      originalAdd(type, listener, options);
      controller.abort();
    };
    const broker = new RunnerCommandBroker({
      commandId: () => "racing-command",
      deliver: () => Boolean(delivered.push("delivered")),
    });

    const result = broker.dispatch(brokerRunnerCommand(), controller.signal);

    expect(delivered).toEqual([]);
    expectRunnerCommandAbort(await captureBrokerRejection(result));
  });

  test("settles and rejects when abort-listener registration throws and cleanup also throws", async () => {
    const controller = failingCleanupController();
    controller.signal.addEventListener = () => {
      throw new Error("listener registration failed");
    };

    failListenerCleanup(controller);
    const broker = new RunnerCommandBroker({
      commandId: () => "listener-registration-throw",
    });

    await expect(
      broker.dispatch(brokerRunnerCommand(), controller.signal),
    ).rejects.toThrow("listener registration failed");
    expectBrokerInactive(broker, "listener-registration-throw");
  });

  test("rejects and releases a command when immediate delivery throws", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "delivery-throw",
      deliver: () => {
        throw new Error("delivery failed");
      },
    });

    await expect(broker.dispatch(brokerRunnerCommand())).rejects.toThrow(
      "delivery failed",
    );

    expectBrokerInactive(broker, "delivery-throw");
  });

  test("rejects and releases a queued command when reconnect delivery throws", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "reconnect-delivery-throw",
    });
    const result = broker.dispatch(brokerRunnerCommand());

    broker.deliverQueued(RUNNER_ID, () => {
      throw new Error("reconnect delivery failed");
    });

    await expect(result).rejects.toThrow("reconnect delivery failed");
    expectBrokerInactive(broker, "reconnect-delivery-throw");
  });

  test("rejects even when in-flight cancellation throws", async () => {
    const broker = new RunnerCommandBroker({
      cancel: () => {
        throw new Error("cancellation cleanup failed");
      },
      commandId: () => "cancellation-cleanup-throw",
      deliver: () => true,
    });

    await dispatchedCancellation(broker);
    expectRejectedCompletion(broker, "cancellation-cleanup-throw");
  });

  test("rejects even when abort-listener cleanup throws", async () => {
    const { broker, result } = cleanupStreamedDispatch(
      "listener-cleanup-throw",
    );

    await cancelAndExpectUnauthorized(broker, result);
    expectRejectedCompletion(broker, "listener-cleanup-throw");
  });

  test("completes and removes a command even when listener cleanup throws", async () => {
    const { broker, result } = cleanupStreamedDispatch(
      "completion-cleanup-throw",
    );

    expectCommandComplete(broker, "completion-cleanup-throw", "done");
    await expect(result).resolves.toEqual(completedRunnerCommand("done"));
    expect(broker.isActive(RUNNER_ID, "completion-cleanup-throw")).toBe(false);
  });

  test("does not push cancellation for a queued command", async () => {
    expect(await expectCanceledCommand(false, "queued-command")).toEqual([]);
  });

  test("delivers a tool command only to its runner and resolves its result", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "command-1",
    });
    const command = {
      arguments: { path: "README.md" },
      executionEnvironment: "bare_metal" as const,
      sessionId: SESSION_ID,
      tool: "read",
      workingDirectory: "/work/project",
    };
    const result = broker.dispatch(brokerRunnerCommand(command));

    expect(broker.take("another-runner")).toBeUndefined();
    expect(broker.take(RUNNER_ID)).toEqual({ ...command, id: "command-1" });
    expect(broker.isActive(RUNNER_ID, "command-1")).toBe(true);
    expect(
      broker.complete(
        "another-runner",
        "command-1",
        completedRunnerCommand("wrong"),
      ),
    ).toBe(false);
    expect(
      broker.complete(
        RUNNER_ID,
        "command-1",
        completedRunnerCommand("# Q Mush"),
      ),
    ).toBe(true);
    expect(broker.isActive(RUNNER_ID, "command-1")).toBe(false);
    expect(await result).toEqual(completedRunnerCommand("# Q Mush"));
  });

  test("keeps pending commands active until completion or cancellation", async () => {
    vi.useFakeTimers();

    try {
      const broker = new RunnerCommandBroker({
        commandId: () => "command-without-deadline",
      });
      const result = broker.dispatch(
        brokerRunnerCommand({ arguments: { command: "long-running-command" } }),
      );
      void result.catch(() => undefined);

      vi.advanceTimersByTime(24 * 60 * 60_000);
      const command = broker.take(RUNNER_ID);
      const wasCompleted = broker.complete(
        RUNNER_ID,
        "command-without-deadline",
        completedRunnerCommand("finished"),
      );

      expect(command?.id).toBe("command-without-deadline");
      expect(wasCompleted).toBe(true);
      expect(await result).toEqual(completedRunnerCommand("finished"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("queues any number of commands for a runner", async () => {
    let nextCommand = 0;
    const broker = new RunnerCommandBroker({
      commandId: () => `unbounded-command-${String((nextCommand += 1))}`,
    });
    const results = Array.from({ length: 101 }, (_, index) =>
      broker.dispatch(
        brokerRunnerCommand({
          arguments: { index },
          sessionId: `session-${String(index)}`,
          tool: "read",
        }),
      ),
    );
    const settledResults = Promise.allSettled(results);
    const commands = Array.from({ length: 101 }, () => broker.take(RUNNER_ID));

    for (const command of commands) {
      if (command !== undefined) {
        broker.complete(
          RUNNER_ID,
          command.id,
          completedRunnerCommand(command.id),
        );
      }
    }

    const settled = await settledResults;
    expect(commands.every((command) => command !== undefined)).toBe(true);
    expect(settled.every(({ status }) => status === "fulfilled")).toBe(true);
  });

  test("removes queued and in-flight commands when a session is stopped", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "command-2",
    });
    const result = broker.dispatch(
      brokerRunnerCommand({ arguments: { command: "sleep 10" } }),
    );
    broker.cancelSession(SESSION_ID);

    expect(broker.take(RUNNER_ID)).toBeUndefined();
    const error = await captureBrokerRejection(result);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
