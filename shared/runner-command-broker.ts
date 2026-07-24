import { randomUUID } from "node:crypto";

export interface RunnerToolCommand {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly workingDirectory: string;
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
  readonly resolve: (output: string) => void;
  readonly runnerId: string;
  readonly signal: AbortSignal | undefined;
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
  ): Promise<string> {
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

    return new Promise<string>((resolve, reject) => {
      const cancel = () => {
        this.#reject(id, abortError("The agent session was stopped"));
      };
      const pending: PendingCommand = {
        abort: signal === undefined ? undefined : cancel,
        command,
        phase: "queued",
        reject,
        resolve,
        runnerId: input.runnerId,
        signal,
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

  complete(runnerId: string, commandId: string, output: string): boolean {
    const pending = this.#pending.get(commandId);

    if (pending?.runnerId !== runnerId) {
      return false;
    }

    this.#settle(commandId, pending);
    pending.resolve(output);
    return true;
  }

  runnerRemoved(
    runnerId: string,
  ): readonly { readonly command: RunnerToolCommand; readonly error: Error }[] {
    const removed = [...this.#pending.values()]
      .filter((pending) => pending.runnerId === runnerId)
      .map((pending) => ({
        command: pending.command,
        error: abortError("The assigned runner was removed"),
      }));
    for (const { command, error } of removed) {
      this.#reject(command.id, error);
    }
    return removed;
  }

  cancelSession(sessionId: string): void {
    this.cancelSessionCommands(sessionId);
  }

  cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[] {
    const commands = [...this.#pending.entries()]
      .filter(([, pending]) => pending.command.sessionId === sessionId)
      .map(([, pending]) => pending.command);
    const commandIds = commands.map(({ id }) => id);

    for (const commandId of commandIds) {
      this.#reject(commandId, abortError("The agent session was stopped"));
    }
    return commands;
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
