import { randomUUID } from "node:crypto";
import { RunnerCommandDelivery } from "./runner-command-delivery.ts";
import {
  type DispatchRunnerToolCommand,
  type RunnerToolCommand,
} from "./runner-command-model.ts";
import {
  abortRunnerCommand,
  ignoreRunnerCommandCleanupError,
  matchingRunnerCommands,
  settlePendingRunnerCommand,
  type PendingRunnerCommand,
} from "./runner-command-pending.ts";
import {
  RunnerCommandSurvivalState,
  type RunnerCommandSurvivalOptions,
} from "./runner-command-survival.ts";
import { RunnerDisconnectedError } from "./runner-disconnected-error.ts";
import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

export type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

export {
  failedRunnerCommandResult,
  readRunnerExecutionEnvironment,
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
  RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT,
  type DispatchRunnerToolCommand,
  type RunnerCommandArguments,
  type RunnerExecutionEnvironment,
  type RunnerToolCommand,
} from "./runner-command-model.ts";

interface RunnerCommandBrokerOptions extends RunnerCommandSurvivalOptions {
  readonly cancel?: (runnerId: string, commandId: string) => void;
  readonly commandId?: () => string;
  readonly deliver?: (runnerId: string, command: RunnerToolCommand) => boolean;
}

type PendingCommand = PendingRunnerCommand;

interface RejectedCommand {
  readonly command: RunnerToolCommand;
  readonly error: Error;
}

export class RunnerCommandBroker {
  readonly #cancel: ((runnerId: string, commandId: string) => void) | undefined;
  readonly #commandId: () => string;
  readonly #deliver:
    ((runnerId: string, command: RunnerToolCommand) => boolean) | undefined;
  readonly #delivery: RunnerCommandDelivery<PendingCommand>;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #processRegistrations = new Map<
    string,
    Readonly<{ commit: () => void; processNonce: string | undefined }>
  >();
  readonly #runnerConnectionGenerations = new Map<string, number>();
  readonly #survival: RunnerCommandSurvivalState;

  constructor(options: RunnerCommandBrokerOptions = {}) {
    this.#cancel = options.cancel;
    this.#commandId = options.commandId ?? randomUUID;
    this.#deliver = options.deliver;
    this.#delivery = new RunnerCommandDelivery((commandId) =>
      this.#pending.get(commandId),
    );
    this.#survival = new RunnerCommandSurvivalState(options);
  }

  dispatch(
    input: DispatchRunnerToolCommand,
    signal?: AbortSignal,
    stream?: (delta: RunnerCommandOutputDelta) => void,
  ): Promise<RunnerCommandResult> {
    if (signal?.aborted) {
      return Promise.reject(
        abortRunnerCommand("The agent session was stopped"),
      );
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
      return Promise.reject(
        abortRunnerCommand("The agent session was stopped"),
      );
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
      this.#reject(id, abortRunnerCommand("The agent session was stopped"));
    };
    return new Promise<RunnerCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        abort: signal === undefined ? undefined : cancel,
        authorize: input.authorize,
        command,
        connectionGeneration: undefined,
        generation: input.generation,
        nextSequence: 0,
        phase: "queued",
        queuedAfterDisconnect: false,
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
          this.#unavailable(input, pending);
          return;
        }
        if (!this.#requireAuthorization(pending)) {
          return;
        }
        pending.connectionGeneration = this.runnerConnectionGeneration(
          input.runnerId,
        );
        pending.phase = "in_flight";
        if (!this.#deliver(input.runnerId, command)) {
          this.#unavailable(input, pending);
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
    pending.connectionGeneration = this.runnerConnectionGeneration(runnerId);
    pending.phase = "in_flight";
    pending.queuedAfterDisconnect = false;
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

  #authorizedQueued(
    runnerId: string,
    excludedCommandIds?: ReadonlySet<string>,
  ): PendingCommand | undefined {
    for (;;) {
      const pending = this.#delivery.next(runnerId, excludedCommandIds);
      if (pending === undefined || this.#requireAuthorization(pending)) {
        return pending;
      }
    }
  }

  #setPendingPhase(
    pending: PendingCommand,
    phase: PendingCommand["phase"],
  ): void {
    if (this.#pending.has(pending.command.id)) {
      pending.phase = phase;
    }
  }

  #unavailable(
    input: DispatchRunnerToolCommand,
    pending: PendingCommand,
  ): void {
    if (input.queueIfUnavailable === false) {
      this.#reject(pending.command.id, new RunnerDisconnectedError());
      return;
    }
    this.#requeue(pending);
  }

  #requeue(pending: PendingCommand): void {
    pending.connectionGeneration = undefined;
    this.#setPendingPhase(pending, "queued");
    if (this.#pending.has(pending.command.id)) {
      this.#delivery.requeue(pending.runnerId, pending.command);
    }
  }

  deliverCancellationTombstones(
    runnerId: string,
    deliver: (commandId: string) => boolean,
  ): boolean {
    return this.#survival.deliverCancellations(runnerId, deliver);
  }

  acknowledgeCancellation(runnerId: string, commandId: string): boolean {
    return this.#survival.acknowledgeCancellation(runnerId, commandId);
  }

  #queuedCommandIds(runnerId: string): ReadonlySet<string> {
    return new Set(
      this.#matchingPending(
        (pending) =>
          pending.runnerId === runnerId && pending.queuedAfterDisconnect,
      ).map(({ command }) => command.id),
    );
  }

  #runnerProcessMatches(runnerId: string, processNonce?: string): boolean {
    if (processNonce === undefined) return false;
    return this.#survival.processMatches(runnerId, processNonce);
  }

  #stageRunnerProcess(
    runnerId: string,
    processNonce: string | undefined,
    lostIds: ReadonlySet<string>,
  ): () => void {
    const processCommit = this.#survival.stageProcess(runnerId, processNonce);
    return () => {
      processCommit();
      for (const commandId of lostIds) {
        this.#reject(
          commandId,
          new RunnerDisconnectedError(
            "The runner process restarted before the command returned",
          ),
          false,
        );
      }
    };
  }

  registerRunnerProcess(runnerId: string, processNonce?: string): boolean {
    const sameProcess = this.#runnerProcessMatches(runnerId, processNonce);
    this.#stageRunnerProcess(
      runnerId,
      processNonce,
      sameProcess ? new Set() : this.#queuedCommandIds(runnerId),
    )();
    return sameProcess;
  }

  commitRunnerProcess(runnerId: string, processNonce?: string): void {
    const registration = this.#processRegistrations.get(runnerId);
    if (registration === undefined) return;
    if (registration.processNonce !== processNonce) return;
    this.#processRegistrations.delete(runnerId);
    registration.commit();
  }

  deliverRunnerCommands(
    runnerId: string,
    processNonce: string | undefined,
    deliver: (command: RunnerToolCommand) => boolean,
    deliverCancellation: (commandId: string) => boolean,
    connectionGeneration?: number,
  ): boolean {
    const sameProcess = this.#runnerProcessMatches(runnerId, processNonce);
    const lostIds = sameProcess
      ? new Set<string>()
      : this.#queuedCommandIds(runnerId);
    const commit = this.#stageRunnerProcess(runnerId, processNonce, lostIds);
    if (
      sameProcess &&
      !this.deliverCancellationTombstones(runnerId, deliverCancellation)
    ) {
      return false;
    }
    const failed = new Set<string>();
    this.deliverQueued(
      runnerId,
      (command) => {
        if (!deliver(command)) failed.add(command.id);
        return !failed.has(command.id);
      },
      connectionGeneration,
      lostIds,
    );
    if (failed.size > 0) return false;
    this.#processRegistrations.set(runnerId, { commit, processNonce });
    return true;
  }

  deliverQueued(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
    connectionGeneration = this.runnerConnectionGeneration(runnerId),
    excludedCommandIds?: ReadonlySet<string>,
  ): void {
    for (;;) {
      const pending = this.#authorizedQueued(runnerId, excludedCommandIds);
      if (pending === undefined) {
        return;
      }
      let delivered: boolean;
      try {
        pending.connectionGeneration = connectionGeneration;
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
      pending.queuedAfterDisconnect = false;
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

  #matchingPending(
    matches: (pending: PendingCommand) => boolean,
  ): PendingCommand[] {
    return matchingRunnerCommands(this.#pending, matches);
  }

  #sessionPending(sessionId: string): PendingCommand[] {
    return this.#matchingPending(
      ({ command }) => command.sessionId === sessionId,
    );
  }

  sessionCommandPhase(
    sessionId: string,
  ): "in_flight" | "queued" | "runner_disconnected" | undefined {
    const commands = this.#sessionPending(sessionId);
    if (commands.length === 0) {
      return undefined;
    }
    if (commands.some(({ queuedAfterDisconnect }) => queuedAfterDisconnect)) {
      return "runner_disconnected";
    }
    return commands.every(({ phase }) => phase === "in_flight")
      ? "in_flight"
      : "queued";
  }

  // Tool names a session still has outstanding, for restart drain reporting.
  sessionPendingTools(sessionId: string): readonly string[] {
    return this.#sessionPending(sessionId).map(({ command }) => command.tool);
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

  runnerConnectionGeneration(runnerId: string): number {
    return this.#runnerConnectionGenerations.get(runnerId) ?? 0;
  }

  replaceRunnerConnection(
    runnerId: string,
    replacedGeneration = this.runnerConnectionGeneration(runnerId),
  ): number {
    if (this.runnerConnectionGeneration(runnerId) !== replacedGeneration) {
      return this.runnerConnectionGeneration(runnerId);
    }
    this.#runnerConnectionGenerations.set(runnerId, replacedGeneration + 1);
    const inFlight = this.#matchingPending(
      ({ connectionGeneration, phase, runnerId: assignedRunner }) =>
        assignedRunner === runnerId &&
        phase === "in_flight" &&
        connectionGeneration === replacedGeneration,
    );
    for (const pending of inFlight) {
      this.#reject(
        pending.command.id,
        new RunnerDisconnectedError(
          "The runner connection was superseded before the command returned",
        ),
        false,
      );
    }
    return replacedGeneration + 1;
  }

  disconnectRunner(runnerId: string, retry = true): void {
    const disconnected = this.#matchingPending(
      ({ phase, runnerId: assignedRunner }) =>
        assignedRunner === runnerId && phase === "in_flight",
    );
    if (!retry) {
      for (const pending of disconnected) {
        this.#reject(pending.command.id, new RunnerDisconnectedError());
      }
      return;
    }
    for (const pending of disconnected.toReversed()) {
      pending.nextSequence = 0;
      pending.queuedAfterDisconnect = true;
      this.#requeue(pending);
    }
  }

  runnerRemoved(runnerId: string): readonly RejectedCommand[] {
    return this.#rejectMatching(
      (pending) => pending.runnerId === runnerId,
      () => abortRunnerCommand("The assigned runner was removed"),
    );
  }

  #cancelMatching(
    matches: (pending: PendingCommand) => boolean,
    message: string,
  ): readonly RunnerToolCommand[] {
    return this.#rejectMatching(matches, () => abortRunnerCommand(message)).map(
      ({ command }) => command,
    );
  }

  cancelSessionGeneration(
    sessionId: string,
    generation: number,
  ): readonly RunnerToolCommand[] {
    return this.#cancelMatching(
      (pending) =>
        pending.generation === generation &&
        pending.command.sessionId === sessionId,
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
      abortRunnerCommand("The agent session was stopped"),
    );
  }

  #reject(commandId: string, error: Error, publishCancellation = true): void {
    const pending = this.#pending.get(commandId);
    if (pending === undefined) {
      return;
    }

    const runnerMayStillBeExecuting =
      pending.phase === "in_flight" || pending.queuedAfterDisconnect;
    if (publishCancellation && runnerMayStillBeExecuting) {
      if (pending.queuedAfterDisconnect) {
        this.#survival.recordCancellation(pending.runnerId, commandId);
      }
      if (this.#cancel !== undefined) {
        const cancel = this.#cancel;
        ignoreRunnerCommandCleanupError(() => {
          cancel(pending.runnerId, commandId);
        });
      }
    }
    this.#settle(commandId, pending);
    pending.reject(error);
  }

  #settle(commandId: string, pending: PendingCommand): void {
    settlePendingRunnerCommand(
      this.#pending,
      this.#delivery,
      commandId,
      pending,
    );
  }
}
