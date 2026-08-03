import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type { RunnerCommandExecutor } from "./runner-command.ts";
import {
  sendOpenRunnerSocketMessage,
  type RunnerWritableSocket,
} from "./runner-socket-send.ts";

interface CommandExecution {
  readonly command: RunnerToolCommand;
  readonly controller: AbortController;
  result: Readonly<Record<string, unknown>> | undefined;
  socket: RunnerWritableSocket;
}

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

export class RunnerCommandExecutions {
  readonly #active = new Map<string, CommandExecution>();
  readonly #commands: RunnerCommandExecutor;

  constructor(commands: RunnerCommandExecutor) {
    this.#commands = commands;
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

  execute(socket: RunnerWritableSocket, command: RunnerToolCommand): void {
    const existing = this.#active.get(command.id);
    if (existing !== undefined) {
      this.#attach(socket, command, existing);
      return;
    }

    const controller = new AbortController();
    const execution: CommandExecution = {
      command,
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
          execution.result = message;
          sendCommandMessage(execution, message);
        }
      });
  }

  #command(commandId: string): CommandExecution | undefined {
    return this.#active.get(commandId);
  }

  cancel(commandId: string): void {
    const execution = this.#command(commandId);
    if (execution === undefined) {
      return;
    }
    execution.controller.abort();
    this.#forget(execution);
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
