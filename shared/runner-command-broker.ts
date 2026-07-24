import { randomUUID } from "node:crypto";
import type {
  ToolStreamChannel,
  ToolStreamTerminalState,
} from "./tool-stream.ts";

export type RunnerCommandTerminalState = ToolStreamTerminalState;

export function failedRunnerCommandResult(
  error: unknown,
  maximumDetailLength: number,
): RunnerCommandResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    output: `Error: ${detail.slice(0, maximumDetailLength)}`,
    state: "failed",
  };
}

export interface RunnerCommandResult {
  readonly output: string;
  readonly state: RunnerCommandTerminalState;
}

export interface RunnerToolCommand {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly workingDirectory: string;
}

export interface RunnerToolOutputDelta {
  readonly channel: Extract<ToolStreamChannel, "stderr" | "stdout">;
  readonly content: string;
  readonly sequence: number;
}

export interface DispatchRunnerToolCommand extends Omit<
  RunnerToolCommand,
  "id"
> {
  readonly runnerId: string;
}

interface RunnerCommandBrokerOptions {
  readonly cancel?: (runnerId: string, commandId: string) => void;
  readonly commandId?: () => string;
  readonly deliver?: (runnerId: string, command: RunnerToolCommand) => boolean;
}

interface PendingCommand {
  readonly abort: (() => void) | undefined;
  readonly command: RunnerToolCommand;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: RunnerCommandResult) => void;
  readonly runnerId: string;
  readonly signal: AbortSignal | undefined;
  readonly stream: ((delta: RunnerToolOutputDelta) => void) | undefined;
  nextSequence: number;
  phase: "in_flight" | "queued";
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export class RunnerCommandBroker {
  readonly #cancel: ((runnerId: string, commandId: string) => void) | undefined;
  readonly #commandId: () => string;
  readonly #deliver:
    ((runnerId: string, command: RunnerToolCommand) => boolean) | undefined;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #queues = new Map<string, RunnerToolCommand[]>();

  constructor(options: RunnerCommandBrokerOptions = {}) {
    this.#cancel = options.cancel;
    this.#commandId = options.commandId ?? randomUUID;
    this.#deliver = options.deliver;
  }

  dispatch(
    input: DispatchRunnerToolCommand,
    signal?: AbortSignal,
    stream?: (delta: RunnerToolOutputDelta) => void,
  ): Promise<RunnerCommandResult> {
    if (signal?.aborted) {
      return Promise.reject(abortError("The agent session was stopped"));
    }

    const id = this.#commandId();

    if (id.length === 0 || this.#pending.has(id)) {
      return Promise.reject(
        new Error("The runner command ID generator returned a duplicate"),
      );
    }

    const command: RunnerToolCommand = {
      arguments: input.arguments,
      id,
      sessionId: input.sessionId,
      tool: input.tool,
      workingDirectory: input.workingDirectory,
    };

    return new Promise<RunnerCommandResult>((resolve, reject) => {
      const cancel = () => {
        this.#reject(id, abortError("The agent session was stopped"));
      };
      const pending: PendingCommand = {
        abort: signal === undefined ? undefined : cancel,
        command,
        nextSequence: 0,
        phase: "queued",
        reject,
        resolve,
        runnerId: input.runnerId,
        signal,
        stream,
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", cancel, { once: true });

      if (signal?.aborted === true) {
        cancel();
        return;
      }

      if (this.#deliver?.(input.runnerId, command) === true) {
        pending.phase = "in_flight";
      } else {
        const queue = this.#queues.get(input.runnerId) ?? [];
        queue.push(command);
        this.#queues.set(input.runnerId, queue);
      }
    });
  }

  take(runnerId: string): RunnerToolCommand | undefined {
    const queue = this.#queues.get(runnerId);

    if (queue === undefined) {
      return undefined;
    }

    for (;;) {
      const command = queue.shift();

      if (command === undefined) {
        this.#queues.delete(runnerId);
        return undefined;
      }

      const pending = this.#setPhase(command, "in_flight");

      if (pending !== undefined) {
        if (queue.length === 0) {
          this.#queues.delete(runnerId);
        }

        return command;
      }
    }
  }

  #queue(runnerId: string): RunnerToolCommand[] {
    const queue = this.#queues.get(runnerId) ?? [];
    this.#queues.set(runnerId, queue);
    return queue;
  }

  #setPhase(
    command: RunnerToolCommand,
    phase: PendingCommand["phase"],
  ): PendingCommand | undefined {
    const pending = this.#pending.get(command.id);
    if (pending !== undefined) {
      pending.phase = phase;
    }
    return pending;
  }

  #requeue(runnerId: string, command: RunnerToolCommand): void {
    if (this.#setPhase(command, "queued") !== undefined) {
      this.#queue(runnerId).unshift(command);
    }
  }

  deliverQueued(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void {
    for (;;) {
      const command = this.take(runnerId);

      if (command === undefined) {
        return;
      }

      if (!deliver(command)) {
        this.#requeue(runnerId, command);
        return;
      }
    }
  }

  isActive(runnerId: string, commandId: string): boolean {
    return this.#pending.get(commandId)?.runnerId === runnerId;
  }

  #pendingFor(runnerId: string, commandId: string): PendingCommand | undefined {
    const pending = this.#pending.get(commandId);
    return pending?.runnerId === runnerId ? pending : undefined;
  }

  stream(
    runnerId: string,
    commandId: string,
    delta: RunnerToolOutputDelta,
  ): boolean {
    const pending = this.#activePending(runnerId, commandId);
    if (
      pending?.nextSequence === undefined ||
      delta.sequence !== pending.nextSequence
    ) {
      return false;
    }

    pending.nextSequence += 1;
    pending.stream?.(delta);
    return true;
  }

  #activePending(
    runnerId: string,
    commandId: string,
  ): PendingCommand | undefined {
    const pending = this.#pendingFor(runnerId, commandId);
    return pending?.phase === "in_flight" ? pending : undefined;
  }

  complete(
    runnerId: string,
    commandId: string,
    result: RunnerCommandResult,
  ): boolean {
    const pending = this.#pendingFor(runnerId, commandId);

    if (pending === undefined) {
      return false;
    }

    this.#settle(commandId, pending);
    pending.resolve(result);
    return true;
  }

  #commandIds(
    predicate: (pending: PendingCommand) => boolean,
  ): readonly string[] {
    return [...this.#pending]
      .filter(([, pending]) => predicate(pending))
      .map(([id]) => id);
  }

  #rejectCommands(commandIds: readonly string[], error: Error): void {
    for (const commandId of commandIds) {
      this.#reject(commandId, error);
    }
  }

  disconnect(runnerId: string): number {
    const commandIds = this.#commandIds(
      (pending) =>
        pending.runnerId === runnerId && pending.phase === "in_flight",
    );
    this.#rejectCommands(
      commandIds,
      new Error("The runner disconnected while executing the command"),
    );
    return commandIds.length;
  }

  cancelSession(sessionId: string): void {
    this.#rejectCommands(
      this.#commandIds((pending) => pending.command.sessionId === sessionId),
      abortError("The agent session was stopped"),
    );
  }

  #reject(commandId: string, error: Error): void {
    const pending = this.#pending.get(commandId);

    if (pending === undefined) {
      return;
    }

    this.#settle(commandId, pending);
    if (pending.phase === "in_flight") {
      this.#cancel?.(pending.runnerId, commandId);
    }
    pending.reject(error);
  }

  #settle(commandId: string, pending: PendingCommand): void {
    this.#pending.delete(commandId);

    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abort);
    }

    if (pending.phase === "queued") {
      const queue = this.#queues.get(pending.runnerId);

      if (queue !== undefined) {
        const index = queue.findIndex(({ id }) => id === commandId);

        if (index >= 0) {
          queue.splice(index, 1);
        }

        if (queue.length === 0) {
          this.#queues.delete(pending.runnerId);
        }
      }
    }
  }
}
