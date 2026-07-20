import { describe, expect, jest, test } from "bun:test";
import {
  RunnerCommandBroker,
  type DispatchRunnerToolCommand,
} from "../runner-command-broker.ts";
import { captureRejection } from "./promise-test-helpers.ts";

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

describe("runner command broker", () => {
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
    expect(broker.isActive(RUNNER_ID, "command-1")).toBeTrue();
    expect(broker.complete("another-runner", "command-1", "wrong")).toBeFalse();
    expect(broker.complete(RUNNER_ID, "command-1", "# Q Mush")).toBeTrue();
    expect(broker.isActive(RUNNER_ID, "command-1")).toBeFalse();
    expect(await result).toBe("# Q Mush");
  });

  test("keeps pending commands active until completion or cancellation", async () => {
    jest.useFakeTimers();

    try {
      const broker = new RunnerCommandBroker({
        commandId: () => "command-without-deadline",
      });
      const result = broker.dispatch(
        runnerCommand({ arguments: { command: "long-running-command" } }),
      );
      void result.catch(() => undefined);

      jest.advanceTimersByTime(24 * 60 * 60_000);
      const command = broker.take(RUNNER_ID);
      const completed = broker.complete(
        RUNNER_ID,
        "command-without-deadline",
        "finished",
      );

      expect(command?.id).toBe("command-without-deadline");
      expect(completed).toBeTrue();
      expect(await result).toBe("finished");
    } finally {
      jest.useRealTimers();
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
    expect(commands.every((command) => command !== undefined)).toBeTrue();
    expect(settled.every(({ status }) => status === "fulfilled")).toBeTrue();
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
    const error = await captureRejection(result);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
