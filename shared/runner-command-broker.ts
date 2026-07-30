import { randomUUID } from "node:crypto";
import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

export type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

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

export type RunnerExecutionEnvironment = "bare_metal" | "container";

export const RUNNER_EXECUTION_CLEANUP_COMMAND = "cleanup_execution_environment";
export const RUNNER_TERMINAL_CLEANUP_ARGUMENT = "terminal";

export function readRunnerExecutionEnvironment(
  value: unknown,
): RunnerExecutionEnvironment | undefined {
  if (value === undefined || value === "bare_metal") {
    return "bare_metal";
  }
  return value === "container" ? value : undefined;
}

export type RunnerCommandArguments = Readonly<Record<string, unknown>>;

export interface RunnerToolCommand {
  readonly arguments: RunnerCommandArguments;
  readonly executionEnvironment: RunnerExecutionEnvironment;
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
  readonly generation?: number;
  readonly runnerId: string;
}

interface RunnerCommandBrokerOptions {
  readonly cancel?: (runnerId: string, commandId: string) => void;
  readonly commandId?: () => string;
  readonly deliver?: (runnerId: string, command: RunnerToolCommand) => boolean;
}

export class RunnerDisconnectedError extends Error {
  constructor() {
    super("The runner disconnected before the command returned");
    this.name = "RunnerDisconnectedError";
  }
}

interface RejectedCommand {
  readonly command: RunnerToolCommand;
  readonly error: Error;
}

interface PendingCommand {
  readonly abort: (() => void) | undefined;
  readonly authorize: (() => boolean) | undefined;
  readonly command: RunnerToolCommand;
  readonly generation: number | undefined;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: RunnerCommandResult) => void;
  readonly runnerId: string;
  readonly signal: AbortSignal | undefined;
  readonly stream: ((delta: RunnerCommandOutputDelta) => void) | undefined;
  nextSequence: number;
  phase: "in_flight" | "queued";
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function ignoreCleanupError(callback: () => void): void {
  try {
    callback();
  } catch {
    // The broker has already fenced the command; cleanup is best effort.
  }
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
    stream?: (delta: RunnerCommandOutputDelta) => void,
  ): Promise<RunnerCommandResult> {
    if (signal?.aborted) {
      return Promise.reject(abortError("The agent session was stopped"));
    }
    let initiallyAuthorized: boolean;
    try {
      initiallyAuthorized = input.authorize?.() !== false;
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (!initiallyAuthorized) {
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
      executionEnvironment: input.executionEnvironment,
      id,
      sessionId: input.sessionId,
      tool: input.tool,
      workingDirectory: input.workingDirectory,
    };

    let added = false;
    const cancel = () => {
      if (!added) {
        return;
      }
      this.#reject(id, abortError("The agent session was stopped"));
    };
    return new Promise<RunnerCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        abort: signal === undefined ? undefined : cancel,
        authorize: input.authorize,
        command,
        generation: input.generation,
        nextSequence: 0,
        phase: "queued",
        reject,
        resolve,
        runnerId: input.runnerId,
        signal,
        stream,
      };
      this.#pending.set(id, pending);
      try {
        signal?.addEventListener("abort", cancel, { once: true });
      } catch (error) {
        added = true;
        this.#rejectUnknown(id, error);
        return;
      }
      added = true;

      try {
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
        pending.phase = "in_flight";
        if (!this.#deliver(input.runnerId, command)) {
          this.#requeue(pending);
        }
      } catch (error) {
        if (this.#pending.has(id)) {
          pending.phase = "queued";
        }
        this.#rejectUnknown(id, error);
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

  #rejectUnknown(commandId: string, error: unknown): void {
    this.#reject(
      commandId,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  #requireAuthorization(pending: PendingCommand): boolean {
    let authorized: boolean;
    try {
      authorized = this.#authorized(pending);
    } catch (error) {
      this.#rejectUnknown(pending.command.id, error);
      return false;
    }
    if (!authorized) {
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

  #setPendingPhase(
    pending: PendingCommand,
    phase: PendingCommand["phase"],
  ): void {
    if (this.#pending.has(pending.command.id)) {
      pending.phase = phase;
    }
  }

  #requeue(pending: PendingCommand): void {
    this.#setPendingPhase(pending, "queued");
    if (this.#pending.has(pending.command.id)) {
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
      let delivered: boolean;
      try {
        pending.phase = "in_flight";
        delivered = deliver(pending.command);
      } catch (error) {
        this.#setPendingPhase(pending, "queued");
        this.#rejectUnknown(pending.command.id, error);
        return;
      }
      if (!delivered) {
        this.#requeue(pending);
        return;
      }
    }
  }

  #settlePending(pending: PendingCommand): void {
    this.#settle(pending.command.id, pending);
  }

  #authorizedForRunner(
    runnerId: string,
    commandId: string,
  ): PendingCommand | undefined {
    const pending = this.#pending.get(commandId);
    return pending?.runnerId === runnerId && this.#requireAuthorization(pending)
      ? pending
      : undefined;
  }

  #authorizedInFlight(
    ...parameters: readonly [runnerId: string, commandId: string]
  ): PendingCommand | undefined {
    const pending = this.#authorizedForRunner(...parameters);
    if (pending?.phase !== "in_flight") {
      return undefined;
    }
    return pending;
  }

  isActive(runnerId: string, commandId: string): boolean {
    return this.#authorizedForRunner(runnerId, commandId) !== undefined;
  }

  #settleAuthorized(
    runnerId: string,
    commandId: string,
    validate?: (pending: PendingCommand) => boolean,
  ): PendingCommand | undefined {
    const pending = this.#authorizedInFlight(runnerId, commandId);
    return pending === undefined || validate?.(pending) === false
      ? undefined
      : pending;
  }

  stream(
    runnerId: string,
    commandId: string,
    delta: RunnerCommandOutputDelta,
  ): boolean {
    const pending = this.#settleAuthorized(
      runnerId,
      commandId,
      (candidate) => delta.sequence === candidate.nextSequence,
    );
    if (pending === undefined) {
      return false;
    }

    pending.nextSequence += 1;
    try {
      pending.stream?.(delta);
    } catch {
      // Live output delivery is observational and must not settle the command.
    }
    return true;
  }

  complete(
    runnerId: string,
    commandId: string,
    result: RunnerCommandResult,
  ): boolean {
    const pending = this.#settleAuthorized(runnerId, commandId);
    if (pending === undefined) {
      return false;
    }
    this.#settlePending(pending);
    pending.resolve(result);
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

  disconnectRunner(runnerId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.runnerId === runnerId && pending.phase === "in_flight") {
        this.#reject(pending.command.id, new RunnerDisconnectedError());
      }
    }
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

  #cancelMatching(
    matches: (pending: PendingCommand) => boolean,
    message: string,
  ): readonly RunnerToolCommand[] {
    return this.#rejectMatching(matches, () => abortError(message)).map(
      ({ command }) => command,
    );
  }

  cancelSessionGeneration(
    sessionId: string,
    generation: number,
  ): readonly RunnerToolCommand[] {
    const generationMatches = (pending: PendingCommand): boolean =>
      pending.generation === generation;
    return this.#cancelMatching(
      (pending) =>
        generationMatches(pending) && pending.command.sessionId === sessionId,
      "The session tools changed",
    );
  }

  cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[] {
    return this.#cancelMatching(
      (pending) => pending.command.sessionId === sessionId,
      "The agent session was stopped",
    );
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
    if (pending.phase === "in_flight" && this.#cancel !== undefined) {
      const cancel = this.#cancel;
      ignoreCleanupError(() => {
        cancel(pending.runnerId, commandId);
      });
    }
    pending.reject(error);
  }

  #settle(commandId: string, pending: PendingCommand): void {
    this.#pending.delete(commandId);

    if (pending.abort !== undefined && pending.signal !== undefined) {
      const abort = pending.abort;
      const signal = pending.signal;
      ignoreCleanupError(() => {
        signal.removeEventListener("abort", abort);
      });
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
