import { describe, expect, test, vi } from "vitest";
import {
  RunnerCommandBroker,
  type DispatchRunnerToolCommand,
  type RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { captureBrokerRejection } from "./promise-test-helpers.ts";

const RUNNER_ID = "runner-1";
const SESSION_ID = "session-1";

function runnerCommand(
  overrides: Partial<DispatchRunnerToolCommand> = {},
): DispatchRunnerToolCommand {
  return {
    arguments: {},
    runnerId: RUNNER_ID,
    sessionId: SESSION_ID,
    tool: "bash",
    workingDirectory: "/work/project",
    ...overrides,
  };
}

function expectAbortError(value: unknown): void {
  expect(value).toMatchObject({ name: "AbortError" });
}

async function expectUnauthorizedResult(
  result: Promise<string>,
): Promise<void> {
  expectAbortError(await captureBrokerRejection(result));
}

interface RevocableDispatch {
  readonly broker: RunnerCommandBroker;
  readonly result: Promise<string>;
  readonly revoke: () => void;
}

function revocableDispatch(
  commandId: string,
  options: {
    readonly cancel?: (runnerId: string, commandId: string) => void;
    readonly deliver?: () => boolean;
  } = {},
): RevocableDispatch {
  let authorized = true;
  const broker = new RunnerCommandBroker({
    ...options,
    commandId: () => commandId,
  });
  return {
    broker,
    result: broker.dispatch(runnerCommand({ authorize: () => authorized })),
    revoke: () => {
      authorized = false;
    },
  };
}

function deliverQueued(
  broker: RunnerCommandBroker,
  delivered: RunnerToolCommand[],
  accepted: boolean,
): void {
  broker.deliverQueued(RUNNER_ID, (command) => {
    delivered.push(command);
    return accepted;
  });
}

async function revokedReconnectDelivery(
  commandId: string,
  requeue: boolean,
): Promise<readonly string[]> {
  const delivered: RunnerToolCommand[] = [];
  const dispatch = revocableDispatch(commandId);
  if (requeue) {
    deliverQueued(dispatch.broker, delivered, false);
  }
  dispatch.revoke();
  deliverQueued(dispatch.broker, delivered, true);
  await expectUnauthorizedResult(dispatch.result);
  expect(dispatch.broker.take(RUNNER_ID)).toBeUndefined();
  return delivered.map(({ id }) => id);
}

async function expectCanceledCommand(
  delivered: boolean,
  commandId: string,
): Promise<readonly string[]> {
  const canceled: string[] = [];
  const broker = new RunnerCommandBroker({
    cancel: (_runnerId, canceledId) => canceled.push(canceledId),
    commandId: () => commandId,
    deliver: () => delivered,
  });
  const result = broker.dispatch(runnerCommand());
  broker.cancelSession(SESSION_ID);
  expectAbortError(await captureBrokerRejection(result));
  return canceled;
}

test("delivers a command immediately when a runner socket is connected", async () => {
  const delivered: unknown[] = [];
  const broker = new RunnerCommandBroker({
    commandId: () => "websocket-command",
    deliver: (runnerId, command) => {
      delivered.push({ command, runnerId });
      return true;
    },
  });
  const result = broker.dispatch(runnerCommand());

  expect(delivered).toEqual([
    {
      command: {
        arguments: {},
        id: "websocket-command",
        sessionId: SESSION_ID,
        tool: "bash",
        workingDirectory: "/work/project",
      },
      runnerId: RUNNER_ID,
    },
  ]);
  expect(broker.take(RUNNER_ID)).toBeUndefined();
  expect(broker.complete(RUNNER_ID, "websocket-command", "done")).toBe(true);
  expect(await result).toBe("done");
});

test("pushes cancellation for an in-flight WebSocket command", async () => {
  expect(await expectCanceledCommand(true, "cancel-websocket-command")).toEqual(
    ["cancel-websocket-command"],
  );
});

describe("runner command broker", () => {
  test("rejects a queued command when authorization is revoked before take", async () => {
    const dispatch = revocableDispatch("revoked-take");

    dispatch.revoke();

    expect(dispatch.broker.take(RUNNER_ID)).toBeUndefined();
    await expectUnauthorizedResult(dispatch.result);
    expect(dispatch.broker.complete(RUNNER_ID, "revoked-take", "late")).toBe(
      false,
    );
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
      runnerCommand({
        authorize: () => {
          authorizationChecks += 1;
          return authorizationChecks < 3;
        },
      }),
    );

    expect(delivered).toEqual([]);
    expect(authorizationChecks).toBe(3);
    await expectUnauthorizedResult(result);
  });

  test("cancels a revoked in-flight command and rejects its completion", async () => {
    const canceled: string[] = [];
    const dispatch = revocableDispatch("revoked-in-flight", {
      cancel: (_runnerId, commandId) => canceled.push(commandId),
      deliver: () => true,
    });

    dispatch.revoke();

    expect(
      dispatch.broker.complete(RUNNER_ID, "revoked-in-flight", "late"),
    ).toBe(false);
    expect(canceled).toEqual(["revoked-in-flight"]);
    await expectUnauthorizedResult(dispatch.result);
    expect(dispatch.broker.isActive(RUNNER_ID, "revoked-in-flight")).toBe(
      false,
    );
  });

  test("fences results from a removed runner", async () => {
    const broker = new RunnerCommandBroker({
      commandId: () => "removed-command",
      deliver: () => true,
    });
    const result = broker.dispatch(runnerCommand());

    const removed = broker.runnerRemoved(RUNNER_ID);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.command.id).toBe("removed-command");
    expectAbortError(removed[0]?.error);
    const rejection = await captureBrokerRejection(result);
    expectAbortError(rejection);
    expect(rejection).toBe(removed[0]?.error);
    expect(broker.complete(RUNNER_ID, "removed-command", "late")).toBe(false);
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

    const result = broker.dispatch(runnerCommand(), controller.signal);

    expect(delivered).toEqual([]);
    expectAbortError(await captureBrokerRejection(result));
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
      sessionId: SESSION_ID,
      tool: "read",
      workingDirectory: "/work/project",
    };
    const result = broker.dispatch(runnerCommand(command));

    expect(broker.take("another-runner")).toBeUndefined();
    expect(broker.take(RUNNER_ID)).toEqual({ ...command, id: "command-1" });
    expect(broker.isActive(RUNNER_ID, "command-1")).toBe(true);
    expect(broker.complete("another-runner", "command-1", "wrong")).toBe(false);
    expect(broker.complete(RUNNER_ID, "command-1", "# Q Mush")).toBe(true);
    expect(broker.isActive(RUNNER_ID, "command-1")).toBe(false);
    expect(await result).toBe("# Q Mush");
  });

  test("keeps pending commands active until completion or cancellation", async () => {
    vi.useFakeTimers();

    try {
      const broker = new RunnerCommandBroker({
        commandId: () => "command-without-deadline",
      });
      const result = broker.dispatch(
        runnerCommand({ arguments: { command: "long-running-command" } }),
      );
      void result.catch(() => undefined);

      vi.advanceTimersByTime(24 * 60 * 60_000);
      const command = broker.take(RUNNER_ID);
      const completed = broker.complete(
        RUNNER_ID,
        "command-without-deadline",
        "finished",
      );

      expect(command?.id).toBe("command-without-deadline");
      expect(completed).toBe(true);
      expect(await result).toBe("finished");
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
        runnerCommand({
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
        broker.complete(RUNNER_ID, command.id, command.id);
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
      runnerCommand({ arguments: { command: "sleep 10" } }),
    );
    broker.cancelSession(SESSION_ID);

    expect(broker.take(RUNNER_ID)).toBeUndefined();
    const error = await captureBrokerRejection(result);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
