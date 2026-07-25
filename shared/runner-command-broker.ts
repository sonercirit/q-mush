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
  readonly authorize?: () => boolean;
  readonly runnerId: string;
}

interface RunnerCommandBrokerOptions {
  readonly cancel?: (runnerId: string, commandId: string) => void;
  readonly commandId?: () => string;
  readonly deliver?: (runnerId: string, command: RunnerToolCommand) => boolean;
}

interface RejectedCommand {
  readonly command: RunnerToolCommand;
  readonly error: Error;
}

interface PendingCommand {
  readonly abort: (() => void) | undefined;
  readonly authorize: (() => boolean) | undefined;
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
    if (signal?.aborted || input.authorize?.() === false) {
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
        authorize: input.authorize,
        command,
        phase: "queued",
        reject,
        resolve,
        runnerId: input.runnerId,
        signal,
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", cancel, { once: true });

      if (!this.#requireAuthorization(pending)) {
        return;
      }

      if (this.#deliver === undefined) {
        this.#queue(input.runnerId).push(command);
        return;
      }
      if (!this.#requireAuthorization(pending)) {
        return;
      }
      if (this.#deliver(input.runnerId, command)) {
        pending.phase = "in_flight";
      } else {
        this.#queue(input.runnerId).push(command);
      }
    });
  }

  take(runnerId: string): RunnerToolCommand | undefined {
    const pending = this.#authorizedQueued(runnerId);
    if (pending === undefined) {
      return undefined;
    }
    pending.phase = "in_flight";
    return pending.command;
  }

  #authorized(pending: PendingCommand): boolean {
    return pending.signal?.aborted !== true && pending.authorize?.() !== false;
  }

  #requireAuthorization(pending: PendingCommand): boolean {
    if (!this.#authorized(pending)) {
      this.#rejectUnauthorized(pending);
      return false;
    }
    return true;
  }

  #authorizedQueued(runnerId: string): PendingCommand | undefined {
    for (;;) {
      const pending = this.#nextQueued(runnerId);
      if (pending === undefined || this.#requireAuthorization(pending)) {
        return pending;
      }
    }
  }

  #nextQueued(runnerId: string): PendingCommand | undefined {
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
      if (queue.length === 0) {
        this.#queues.delete(runnerId);
      }
      const pending = this.#pending.get(command.id);
      if (pending !== undefined) {
        return pending;
      }
    }
  }

  #queue(runnerId: string): RunnerToolCommand[] {
    const queue = this.#queues.get(runnerId) ?? [];
    this.#queues.set(runnerId, queue);
    return queue;
  }

  #requeue(pending: PendingCommand): void {
    if (this.#pending.has(pending.command.id)) {
      pending.phase = "queued";
      this.#queue(pending.runnerId).unshift(pending.command);
    }
  }

  deliverQueued(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void {
    for (;;) {
      const pending = this.#authorizedQueued(runnerId);
      if (pending === undefined) {
        return;
      }
      if (!deliver(pending.command)) {
        this.#requeue(pending);
        return;
      }
      pending.phase = "in_flight";
    }
  }

  #settlePending(pending: PendingCommand): void {
    this.#settle(pending.command.id, pending);
  }

  #pendingForRunner(
    runnerId: string,
    commandId: string,
  ): PendingCommand | undefined {
    const pending = this.#pending.get(commandId);
    return pending?.runnerId === runnerId ? pending : undefined;
  }

  isActive(runnerId: string, commandId: string): boolean {
    const pending = this.#pendingForRunner(runnerId, commandId);
    return pending !== undefined && this.#requireAuthorization(pending);
  }

  complete(runnerId: string, commandId: string, output: string): boolean {
    const pending = this.#pendingForRunner(runnerId, commandId);
    if (pending === undefined || !this.#requireAuthorization(pending)) {
      return false;
    }

    this.#settlePending(pending);
    pending.resolve(output);
    return true;
  }

  #rejectMatching(
    matches: (pending: PendingCommand) => boolean,
    error: () => Error,
  ): readonly RejectedCommand[] {
    const matching = [...this.#pending.values()]
      .filter(matches)
      .map((pending) => ({ command: pending.command, error: error() }));
    for (const rejected of matching) {
      this.#reject(rejected.command.id, rejected.error);
    }
    return matching;
  }

  runnerRemoved(runnerId: string): readonly RejectedCommand[] {
    return this.#rejectMatching(
      (pending) => pending.runnerId === runnerId,
      () => abortError("The assigned runner was removed"),
    );
  }

  cancelSession(sessionId: string): void {
    this.cancelSessionCommands(sessionId);
  }

  cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[] {
    return this.#rejectMatching(
      (pending) => pending.command.sessionId === sessionId,
      () => abortError("The agent session was stopped"),
    ).map(({ command }) => command);
  }

  #rejectUnauthorized(pending: PendingCommand): void {
    this.#reject(
      pending.command.id,
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
