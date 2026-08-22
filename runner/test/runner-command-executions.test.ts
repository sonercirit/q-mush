import { expect, test, vi } from "vitest";
import { RunnerCommandExecutions } from "../../runner/runner-command-executions.ts";
import type { RunnerCommandExecutor } from "../../runner/runner-command.ts";
import type { RunnerWritableSocket } from "../../runner/runner-socket-send.ts";
import { isRecord } from "../../shared/auth-model.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import type { RunnerCommandResult } from "../../shared/tool-stream.ts";

function command(id: string): RunnerToolCommand {
  return {
    arguments: {},
    executionEnvironment: "bare_metal",
    id,
    sessionId: "session-1",
    tool: "read",
    workingDirectory: "/workspace",
  };
}

function controlledExecutor() {
  const completions = new Map<string, (result: RunnerCommandResult) => void>();
  const aborted: string[] = [];
  const calls: string[] = [];
  class ControlledExecutor implements Pick<
    RunnerCommandExecutor,
    "executeResult"
  > {
    executeResult(
      selected: RunnerToolCommand,
      signal?: AbortSignal,
    ): Promise<RunnerCommandResult> {
      calls.push(selected.id);
      signal?.addEventListener(
        "abort",
        () => {
          aborted.push(selected.id);
        },
        { once: true },
      );
      return new Promise<RunnerCommandResult>((resolve) => {
        completions.set(selected.id, resolve);
      });
    }
  }
  return { aborted, calls, completions, executor: new ControlledExecutor() };
}

function socket() {
  const sent: Readonly<Record<string, unknown>>[] = [];
  const writable: RunnerWritableSocket = {
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    send: (message) => {
      if (typeof message !== "string") {
        throw new Error("The runner execution test received binary data");
      }
      const parsed: unknown = JSON.parse(message);
      if (!isRecord(parsed)) {
        throw new Error("The runner execution test received invalid JSON");
      }
      sent.push(parsed);
    },
  };
  return { sent, writable };
}

async function flush(): Promise<void> {
  await Bun.sleep(0);
}

function executionSetup() {
  const controlled = controlledExecutor();
  const connected = socket();
  return {
    connected,
    controlled,
    executions: new RunnerCommandExecutions(controlled.executor),
  };
}

test("replays a completed result after reconnect until the engine acknowledges it", async () => {
  const setup = executionSetup();
  const second = socket();
  const selected = command("lost-ack-result");

  setup.executions.execute(setup.connected.writable, selected);
  setup.controlled.completions.get(selected.id)?.({
    output: "complete",
    state: "completed",
  });
  await flush();
  setup.executions.connected(second.writable);

  expect(setup.controlled.calls).toEqual([selected.id]);
  expect(second.sent).toContainEqual({
    commandId: selected.id,
    output: "complete",
    state: "completed",
    type: "result",
  });
  setup.executions.resultReceived(selected.id);
  second.sent.length = 0;
  setup.executions.connected(second.writable);
  expect(second.sent).toEqual([]);
});

test("acknowledges a cancellation tombstone and discards the surviving execution", () => {
  const setup = executionSetup();
  const selected = command("disconnect-gap-cancel");

  setup.executions.execute(setup.connected.writable, selected);
  setup.executions.cancel(setup.connected.writable, selected.id);

  expect(setup.controlled.aborted).toEqual([selected.id]);
  expect(setup.connected.sent.at(-1)).toEqual({
    commandId: selected.id,
    type: "cancellation_received",
  });
  setup.executions.execute(setup.connected.writable, selected);
  expect(setup.controlled.calls).toEqual([selected.id, selected.id]);
});

test("drops old unacknowledged results at the bounded retention cap with loud logging", async () => {
  const controlled = controlledExecutor();
  const connected = socket();
  const logs: string[] = [];
  const executions = new RunnerCommandExecutions(controlled.executor, {
    log: (message) => logs.push(message),
    maximumCompletedExecutions: 1,
  });

  executions.execute(connected.writable, command("retained-1"));
  controlled.completions.get("retained-1")?.({
    output: "one",
    state: "completed",
  });
  await flush();
  executions.execute(connected.writable, command("retained-2"));
  controlled.completions.get("retained-2")?.({
    output: "two",
    state: "completed",
  });
  await flush();
  connected.sent.length = 0;
  executions.connected(connected.writable);

  expect(logs).toEqual([
    expect.stringContaining("retained-1 after reaching the retention limit"),
  ]);
  expect(connected.sent).toEqual([
    {
      commandId: "retained-2",
      output: "two",
      state: "completed",
      type: "result",
    },
  ]);
});
