import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type { RunnerCommandExecutor } from "./runner-command.ts";
import {
  sendOpenRunnerSocketMessage,
  type RunnerWritableSocket,
} from "./runner-socket-send.ts";

const COMPLETED_EXECUTION_TTL_MILLISECONDS = 24 * 60 * 60_000;
const MAXIMUM_COMPLETED_EXECUTIONS = 1_000;

interface CommandExecution {
  readonly command: RunnerToolCommand;
  completedAt: number | undefined;
  readonly controller: AbortController;
  result: Readonly<Record<string, unknown>> | undefined;
  retentionTimer: ReturnType<typeof setTimeout> | undefined;
  socket: RunnerWritableSocket;
}

interface RunnerCommandExecutionsOptions {
  readonly completedExecutionTtlMs?: number;
  readonly log?: (message: string) => void;
  readonly maximumCompletedExecutions?: number;
  readonly now?: () => number;
}

type CommandExecutor = Pick<RunnerCommandExecutor, "executeResult">;

function sendCommandMessage(
  execution: CommandExecution,
  message: Readonly<Record<string, unknown>>,
): void {
  sendOpenRunnerSocketMessage(execution.socket, {
    ...message,
    commandId: execution.command.id,
  });
}

function commandsMatch(
  first: RunnerToolCommand,
  second: RunnerToolCommand,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be positive`);
  }
  return value;
}

export function createRunnerCommandExecutions(
  commands: CommandExecutor,
  options: RunnerCommandExecutionsOptions = {},
) {
  const active = new Map<string, CommandExecution>();

  commands = commands;
  const completedExecutionTtlMs = requirePositiveInteger(
    options.completedExecutionTtlMs ?? COMPLETED_EXECUTION_TTL_MILLISECONDS,
    "The completed runner execution TTL",
  );
  const log = options.log ?? console.error;
  const maximumCompletedExecutions = requirePositiveInteger(
    options.maximumCompletedExecutions ?? MAXIMUM_COMPLETED_EXECUTIONS,
    "The completed runner execution limit",
  );
  const now = options.now ?? Date.now;

  function useSocket(
    execution: CommandExecution,
    socket: RunnerWritableSocket,
  ): void {
    execution.socket = socket;
    if (execution.result !== undefined) {
      sendCommandMessage(execution, execution.result);
    }
  }

  function attach(
    socket: RunnerWritableSocket,
    command: RunnerToolCommand,
    execution: CommandExecution,
  ): void {
    if (!commandsMatch(command, execution.command)) {
      socket.close(1008, "Conflicting command ID");
      return;
    }
    useSocket(execution, socket);
  }

  function forget(execution: CommandExecution): void {
    if (active.get(execution.command.id) === execution) {
      active.delete(execution.command.id);
    }
    if (execution.retentionTimer !== undefined) {
      clearTimeout(execution.retentionTimer);
      execution.retentionTimer = undefined;
    }
  }

  function discardCompleted(execution: CommandExecution, reason: string): void {
    forget(execution);
    log(
      `Q Mush discarded unacknowledged result for runner command ${execution.command.id} ${reason}.`,
    );
  }

  function scheduleExpiry(execution: CommandExecution): void {
    execution.retentionTimer = setTimeout(() => {
      execution.retentionTimer = undefined;
      if (
        active.get(execution.command.id) === execution &&
        execution.result !== undefined
      ) {
        discardCompleted(execution, "after its retention TTL elapsed");
      }
    }, completedExecutionTtlMs);
    execution.retentionTimer.unref();
  }

  function prune(): void {
    const currentTime = now();
    const completed = [...active.values()]
      .filter(
        (execution): execution is CommandExecution & { completedAt: number } =>
          execution.result !== undefined && execution.completedAt !== undefined,
      )
      .sort((first, second) => first.completedAt - second.completedAt);
    for (const execution of completed) {
      if (currentTime - execution.completedAt >= completedExecutionTtlMs) {
        discardCompleted(execution, "after its retention TTL elapsed");
      }
    }
    const retained = completed.filter(
      (execution) => active.get(execution.command.id) === execution,
    );
    const excess = retained.length - maximumCompletedExecutions;
    for (const execution of retained.slice(0, Math.max(excess, 0))) {
      discardCompleted(execution, "after reaching the retention limit");
    }
  }

  function connected(socket: RunnerWritableSocket): void {
    prune();
    for (const execution of active.values()) {
      useSocket(execution, socket);
    }
  }

  function execute(
    socket: RunnerWritableSocket,
    command: RunnerToolCommand,
  ): void {
    prune();
    const existing = active.get(command.id);
    if (existing !== undefined) {
      attach(socket, command, existing);
      return;
    }

    const controller = new AbortController();
    const execution: CommandExecution = {
      command,
      completedAt: undefined,
      controller,
      result: undefined,
      retentionTimer: undefined,
      socket,
    };
    active.set(command.id, execution);
    let sequence = 0;
    void commands
      .executeResult(command, controller.signal, (delta) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = { ...delta, sequence, type: "output" };
        sendCommandMessage(execution, message);
        sequence += 1;
      })
      .then((result) => {
        const message = { ...result, type: "result" };
        if (!controller.signal.aborted) {
          execution.completedAt = now();
          execution.result = message;
          scheduleExpiry(execution);
          sendCommandMessage(execution, message);
          prune();
        }
      });
  }

  function cancel(socket: RunnerWritableSocket, commandId: string): void {
    const execution = active.get(commandId);
    if (execution !== undefined) {
      execution.controller.abort();
      forget(execution);
    }
    sendOpenRunnerSocketMessage(socket, {
      commandId,
      type: "cancellation_received",
    });
  }

  function resultReceived(commandId: string): void {
    const completed = active.get(commandId);
    if (completed?.result === undefined) {
      return;
    }
    forget(completed);
  }

  function abortAll(): void {
    for (const execution of active.values()) {
      execution.controller.abort();
    }
    active.clear();
  }

  return { abortAll, cancel, connected, execute, resultReceived };
}

export type RunnerCommandExecutions = ReturnType<
  typeof createRunnerCommandExecutions
>;
