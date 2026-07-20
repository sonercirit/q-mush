import { randomUUID } from "node:crypto";

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 10 * 60_000;
const MAXIMUM_QUEUED_COMMANDS_PER_RUNNER = 100;

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
  readonly commandId?: () => string;
  readonly timeoutMilliseconds?: number;
}

interface PendingCommand {
  readonly abort: (() => void) | undefined;
  readonly command: RunnerToolCommand;
  readonly reject: (error: Error) => void;
  readonly resolve: (output: string) => void;
  readonly runnerId: string;
  readonly signal: AbortSignal | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
  phase: "in_flight" | "queued";
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export class RunnerCommandBroker {
  readonly #commandId: () => string;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #queues = new Map<string, RunnerToolCommand[]>();
  readonly #timeoutMilliseconds: number;

  constructor(options: RunnerCommandBrokerOptions = {}) {
    this.#commandId = options.commandId ?? randomUUID;
    this.#timeoutMilliseconds =
      options.timeoutMilliseconds ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS;

    if (
      !Number.isSafeInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds <= 0
    ) {
      throw new Error("The runner command timeout must be a positive integer");
    }
  }

  dispatch(
    input: DispatchRunnerToolCommand,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(abortError("The agent session was stopped"));
    }

    const queue = this.#queues.get(input.runnerId) ?? [];

    if (queue.length >= MAXIMUM_QUEUED_COMMANDS_PER_RUNNER) {
      return Promise.reject(new Error("The runner command queue is full"));
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
      const timer = setTimeout(() => {
        this.#reject(id, new Error("The runner command timed out"));
      }, this.#timeoutMilliseconds);
      const pending: PendingCommand = {
        abort: signal === undefined ? undefined : cancel,
        command,
        phase: "queued",
        reject,
        resolve,
        runnerId: input.runnerId,
        signal,
        timer,
      };
      this.#pending.set(id, pending);
      queue.push(command);
      this.#queues.set(input.runnerId, queue);
      signal?.addEventListener("abort", cancel, { once: true });
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

      const pending = this.#pending.get(command.id);

      if (pending !== undefined) {
        pending.phase = "in_flight";

        if (queue.length === 0) {
          this.#queues.delete(runnerId);
        }

        return command;
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

  cancelSession(sessionId: string): void {
    const commandIds = [...this.#pending.entries()]
      .filter(([, pending]) => pending.command.sessionId === sessionId)
      .map(([id]) => id);

    for (const commandId of commandIds) {
      this.#reject(commandId, abortError("The agent session was stopped"));
    }
  }

  #reject(commandId: string, error: Error): void {
    const pending = this.#pending.get(commandId);

    if (pending === undefined) {
      return;
    }

    this.#settle(commandId, pending);
    pending.reject(error);
  }

  #settle(commandId: string, pending: PendingCommand): void {
    this.#pending.delete(commandId);
    clearTimeout(pending.timer);

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
