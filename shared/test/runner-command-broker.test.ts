import { describe, expect, test, vi } from "vitest";
import {
  RunnerCommandBroker,
  type DispatchRunnerToolCommand,
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
