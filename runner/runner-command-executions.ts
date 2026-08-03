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

export class RunnerCommandExecutions {
  readonly #active = new Map<string, CommandExecution>();
  readonly #commands: CommandExecutor;
  readonly #completedExecutionTtlMs: number;
  readonly #log: (message: string) => void;
  readonly #maximumCompletedExecutions: number;
  readonly #now: () => number;

  constructor(
    commands: CommandExecutor,
    options: RunnerCommandExecutionsOptions = {},
  ) {
    this.#commands = commands;
    this.#completedExecutionTtlMs = requirePositiveInteger(
      options.completedExecutionTtlMs ?? COMPLETED_EXECUTION_TTL_MILLISECONDS,
      "The completed runner execution TTL",
    );
    this.#log = options.log ?? console.error;
    this.#maximumCompletedExecutions = requirePositiveInteger(
      options.maximumCompletedExecutions ?? MAXIMUM_COMPLETED_EXECUTIONS,
      "The completed runner execution limit",
    );
    this.#now = options.now ?? Date.now;
  }

  #attach(
    socket: RunnerWritableSocket,
    command: RunnerToolCommand,
    execution: CommandExecution,
  ): void {
    if (!commandsMatch(command, execution.command)) {
      socket.close(1008, "Conflicting command ID");
      return;
    }
    execution.socket = socket;
    if (execution.result !== undefined) {
      sendCommandMessage(execution, execution.result);
    }
  }

  #forget(execution: CommandExecution): void {
    if (this.#active.get(execution.command.id) === execution) {
      this.#active.delete(execution.command.id);
    }
  }

  #discardCompleted(execution: CommandExecution, reason: string): void {
    this.#forget(execution);
    this.#log(
      `Q Mush discarded unacknowledged result for runner command ${execution.command.id} ${reason}.`,
    );
  }

  #prune(): void {
    const now = this.#now();
    const completed = [...this.#active.values()]
      .filter(
        (execution): execution is CommandExecution & { completedAt: number } =>
          execution.result !== undefined && execution.completedAt !== undefined,
      )
      .sort((first, second) => first.completedAt - second.completedAt);
    for (const execution of completed) {
      if (now - execution.completedAt >= this.#completedExecutionTtlMs) {
        this.#discardCompleted(execution, "after its retention TTL elapsed");
      }
    }
    const retained = completed.filter(
      (execution) => this.#active.get(execution.command.id) === execution,
    );
    const excess = retained.length - this.#maximumCompletedExecutions;
    for (const execution of retained.slice(0, Math.max(excess, 0))) {
      this.#discardCompleted(execution, "after reaching the retention limit");
    }
  }

  connected(socket: RunnerWritableSocket): void {
    this.#prune();
    for (const execution of this.#active.values()) {
      execution.socket = socket;
      if (execution.result !== undefined) {
        sendCommandMessage(execution, execution.result);
      }
    }
  }

  execute(socket: RunnerWritableSocket, command: RunnerToolCommand): void {
    this.#prune();
    const existing = this.#active.get(command.id);
    if (existing !== undefined) {
      this.#attach(socket, command, existing);
      return;
    }

    const controller = new AbortController();
    const execution: CommandExecution = {
      command,
      completedAt: undefined,
      controller,
      result: undefined,
      socket,
    };
    this.#active.set(command.id, execution);
    let sequence = 0;
    void this.#commands
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
          execution.completedAt = this.#now();
          execution.result = message;
          sendCommandMessage(execution, message);
          this.#prune();
        }
      });
  }

  cancel(socket: RunnerWritableSocket, commandId: string): void {
    const execution = this.#active.get(commandId);
    if (execution !== undefined) {
      execution.controller.abort();
      this.#forget(execution);
    }
    sendOpenRunnerSocketMessage(socket, {
      commandId,
      type: "cancellation_received",
    });
  }

  resultReceived(commandId: string): void {
    const completed = this.#active.get(commandId);
    if (completed?.result === undefined) {
      return;
    }
    this.#forget(completed);
  }

  abortAll(): void {
    for (const execution of this.#active.values()) {
      execution.controller.abort();
    }
    this.#active.clear();
  }
}
