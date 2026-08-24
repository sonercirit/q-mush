import { randomUUID } from "node:crypto";
import { countRestartProgressTools } from "./restart-progress-tools.ts";
import type { RestartProgressTool } from "./restart-progress.ts";
import {
  createRunnerCommandDelivery,
} from "./runner-command-delivery.ts";
import {
  abortRunnerCommand,
  ignoreRunnerCommandCleanupError,
  matchingRunnerCommands,
  settlePendingRunnerCommand,
  type PendingRunnerCommand,
} from "./runner-command-pending.ts";
import {
  createRunnerCommandSurvivalState,
  type RunnerCommandSurvivalOptions,
} from "./runner-command-survival.ts";
import {
  type DispatchRunnerToolCommand,
  type RunnerCommandOutputDelta,
  type RunnerCommandStream,
  type RunnerCommandTransport,
  type RunnerToolCommand,
} from "./runner-command.ts";
import { createRunnerDisconnectedError } from "./runner-disconnected-error.ts";
import type { RunnerCommandResult } from "./tool-stream.ts";
import { abortSignalError, errorFromUnknown } from "./validation.ts";

export {
  failedRunnerCommandResult,
  readRunnerExecutionEnvironment,
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type DispatchRunnerToolCommand,
  type RunnerCommandArguments,
  type RunnerExecutionEnvironment,
  type RunnerToolCommand,
} from "./runner-command.ts";
export type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

interface RunnerCommandBrokerOptions
  extends RunnerCommandSurvivalOptions, RunnerCommandTransport {}

interface RejectedCommand {
  readonly command: RunnerToolCommand;
  readonly error: Error;
}

export interface RunnerCommandBroker {
  dispatch(input: DispatchRunnerToolCommand, signal?: AbortSignal, stream?: RunnerCommandStream): Promise<RunnerCommandResult>;
  take(runnerId: string): RunnerToolCommand | undefined;
  deliverCancellationTombstones(runnerId: string, deliver: (commandId: string) => boolean): boolean;
  acknowledgeCancellation(runnerId: string, commandId: string): boolean;
  registerRunnerProcess(runnerId: string, processNonce?: string): boolean;
  commitRunnerProcess(runnerId: string, processNonce?: string): void;
  deliverRunnerCommands(runnerId: string, processNonce: string | undefined, deliver: (command: RunnerToolCommand) => boolean, deliverCancellation: (commandId: string) => boolean, connectionGeneration?: number): boolean;
  deliverQueued(runnerId: string, deliver: (command: RunnerToolCommand) => boolean, connectionGeneration?: number, excludedCommandIds?: ReadonlySet<string>): void;
  isActive(runnerId: string, commandId: string): boolean;
  pendingToolProgress(sessionId: string): readonly RestartProgressTool[];
  sessionCommandPhase(sessionId: string): "in_flight" | "queued" | "runner_disconnected" | undefined;
  stream(runnerId: string, commandId: string, delta: RunnerCommandOutputDelta): boolean;
  complete(runnerId: string, commandId: string, result: RunnerCommandResult): boolean;
  runnerConnectionGeneration(runnerId: string): number;
  replaceRunnerConnection(runnerId: string, replacedGeneration?: number): number;
  disconnectRunner(runnerId: string, retry?: boolean): void;
  runnerRemoved(runnerId: string): readonly RejectedCommand[];
  cancelSessionGeneration(sessionId: string, generation: number): readonly RunnerToolCommand[];
  cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[];
}

export function createRunnerCommandBroker(options: RunnerCommandBrokerOptions = {}): RunnerCommandBroker {
  const cancelCommand = options.cancel;
  const generateCommandId = options.commandId ?? randomUUID;
  const deliverCommand = options.deliver;
  const pendingCommands = new Map<string, PendingRunnerCommand>();
  const processRegistrations = new Map<string, Readonly<{ commit: () => void; processNonce: string | undefined }>>();
  const runnerConnectionGenerations = new Map<string, number>();
  const delivery = createRunnerCommandDelivery((commandId) => pendingCommands.get(commandId));
  const survival = createRunnerCommandSurvivalState(options);
  function dispatch(
    input: DispatchRunnerToolCommand,
    signal?: AbortSignal,
    stream?: RunnerCommandStream,
  ): Promise<RunnerCommandResult> {
    if (signal?.aborted) {
      return Promise.reject(
        abortSignalError(signal, "The agent session was stopped"),
      );
    }
    let initiallyAuthorized: boolean;
    try {
      initiallyAuthorized = input.authorize?.() !== false;
    } catch (error) {
      return Promise.reject(errorFromUnknown(error));
    }
    if (!initiallyAuthorized) {
      return Promise.reject(
        abortRunnerCommand("The agent session was stopped"),
      );
    }

    const id = generateCommandId();

    if (id.length === 0 || pendingCommands.has(id)) {
      return Promise.reject(
        new Error("The runner command ID generator returned a duplicate"),
      );
    }

    const command: RunnerToolCommand = {
      arguments: input.arguments,
      executionEnvironment: input.executionEnvironment,
      ...(input.executionLimitSeconds === undefined
        ? {}
        : { executionLimitSeconds: input.executionLimitSeconds }),
      id,
      ...(input.outputLimitCharacters === undefined
        ? {}
        : { outputLimitCharacters: input.outputLimitCharacters }),
      sessionId: input.sessionId,
      tool: input.tool,
      workingDirectory: input.workingDirectory,
    };

    let added = false;
    const cancel = () => {
      if (!added) {
        return;
      }
      reject(
        id,
        signal === undefined
          ? abortRunnerCommand("The agent session was stopped")
          : abortSignalError(signal, "The agent session was stopped"),
      );
    };
    return new Promise<RunnerCommandResult>((resolve, reject) => {
      const pending: PendingRunnerCommand = {
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
      pendingCommands.set(id, pending);
      try {
        signal?.addEventListener("abort", cancel, { once: true });
      } catch (error) {
        added = true;
        rejectUnknown(id, error);
        return;
      }
      added = true;

      try {
        if (!requireAuthorization(pending)) {
          return;
        }

        if (deliverCommand === undefined) {
          unavailable(input, pending);
          return;
        }
        if (!requireAuthorization(pending)) {
          return;
        }
        pending.connectionGeneration = runnerConnectionGeneration(
          input.runnerId,
        );
        pending.phase = "in_flight";
        if (!deliverCommand(input.runnerId, command)) {
          unavailable(input, pending);
        }
      } catch (error) {
        if (pendingCommands.has(id)) {
          pending.phase = "queued";
        }
        rejectUnknown(id, error);
      }
    });
  }

  function take(runnerId: string): RunnerToolCommand | undefined {
    const pending = authorizedQueued(runnerId);
    if (pending === undefined) {
      return undefined;
    }
    pending.connectionGeneration = runnerConnectionGeneration(runnerId);
    pending.phase = "in_flight";
    pending.queuedAfterDisconnect = false;
    return pending.command;
  }

  function isAuthorized(pending: PendingRunnerCommand): boolean {
    return pending.signal?.aborted !== true && pending.authorize?.() !== false;
  }

  function rejectUnknown(commandId: string, error: unknown): void {
    reject(commandId, errorFromUnknown(error));
  }

  function requireAuthorization(pending: PendingRunnerCommand): boolean {
    let authorized: boolean;
    try {
      authorized = isAuthorized(pending);
    } catch (error) {
      rejectUnknown(pending.command.id, error);
      return false;
    }
    if (!authorized) {
      rejectUnauthorized(pending);
      return false;
    }
    return true;
  }

  function authorizedQueued(
    runnerId: string,
    excludedCommandIds?: ReadonlySet<string>,
  ): PendingRunnerCommand | undefined {
    for (;;) {
      const pending = delivery.next(runnerId, excludedCommandIds);
      if (pending === undefined || requireAuthorization(pending)) {
        return pending;
      }
    }
  }

  function setPendingPhase(
    pending: PendingRunnerCommand,
    phase: PendingRunnerCommand["phase"],
  ): void {
    if (pendingCommands.has(pending.command.id)) {
      pending.phase = phase;
    }
  }

  function unavailable(
    input: DispatchRunnerToolCommand,
    pending: PendingRunnerCommand,
  ): void {
    if (input.queueIfUnavailable === false) {
      reject(pending.command.id, createRunnerDisconnectedError());
      return;
    }
    requeue(pending);
  }

  function requeue(pending: PendingRunnerCommand): void {
    pending.connectionGeneration = undefined;
    setPendingPhase(pending, "queued");
    if (pendingCommands.has(pending.command.id)) {
      delivery.requeue(pending.runnerId, pending.command);
    }
  }

  function deliverCancellationTombstones(
    runnerId: string,
    deliver: (commandId: string) => boolean,
  ): boolean {
    return survival.deliverCancellations(runnerId, deliver);
  }

  function acknowledgeCancellation(runnerId: string, commandId: string): boolean {
    return survival.acknowledgeCancellation(runnerId, commandId);
  }

  function queuedCommandIds(runnerId: string): ReadonlySet<string> {
    return new Set(
      matchingPending(
        (pending) =>
          pending.runnerId === runnerId && pending.queuedAfterDisconnect,
      ).map(({ command }) => command.id),
    );
  }

  function runnerProcessMatches(runnerId: string, processNonce?: string): boolean {
    if (processNonce === undefined) return false;
    return survival.processMatches(runnerId, processNonce);
  }

  function stageRunnerProcess(
    runnerId: string,
    processNonce: string | undefined,
    lostIds: ReadonlySet<string>,
  ): () => void {
    const processCommit = survival.stageProcess(runnerId, processNonce);
    return () => {
      processCommit();
      for (const commandId of lostIds) {
        reject(
          commandId,
          createRunnerDisconnectedError(
            "The runner process restarted before the command returned",
          ),
          false,
        );
      }
    };
  }

  function registerRunnerProcess(runnerId: string, processNonce?: string): boolean {
    const sameProcess = runnerProcessMatches(runnerId, processNonce);
    stageRunnerProcess(
      runnerId,
      processNonce,
      sameProcess ? new Set() : queuedCommandIds(runnerId),
    )();
    return sameProcess;
  }

  function commitRunnerProcess(runnerId: string, processNonce?: string): void {
    const registration = processRegistrations.get(runnerId);
    if (registration === undefined) return;
    if (registration.processNonce !== processNonce) return;
    processRegistrations.delete(runnerId);
    registration.commit();
  }

  function deliverRunnerCommands(
    runnerId: string,
    processNonce: string | undefined,
    deliver: (command: RunnerToolCommand) => boolean,
    deliverCancellation: (commandId: string) => boolean,
    connectionGeneration?: number,
  ): boolean {
    const sameProcess = runnerProcessMatches(runnerId, processNonce);
    const lostIds = sameProcess
      ? new Set<string>()
      : queuedCommandIds(runnerId);
    const commit = stageRunnerProcess(runnerId, processNonce, lostIds);
    if (
      sameProcess &&
      !deliverCancellationTombstones(runnerId, deliverCancellation)
    ) {
      return false;
    }
    const failed = new Set<string>();
    deliverQueued(
      runnerId,
      (command) => {
        if (!deliver(command)) failed.add(command.id);
        return !failed.has(command.id);
      },
      connectionGeneration,
      lostIds,
    );
    if (failed.size > 0) return false;
    processRegistrations.set(runnerId, { commit, processNonce });
    return true;
  }

  function deliverQueued(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
    connectionGeneration = runnerConnectionGeneration(runnerId),
    excludedCommandIds?: ReadonlySet<string>,
  ): void {
    for (;;) {
      const pending = authorizedQueued(runnerId, excludedCommandIds);
      if (pending === undefined) {
        return;
      }
      let delivered: boolean;
      try {
        pending.connectionGeneration = connectionGeneration;
        pending.phase = "in_flight";
        delivered = deliver(pending.command);
      } catch (error) {
        setPendingPhase(pending, "queued");
        rejectUnknown(pending.command.id, error);
        return;
      }
      if (!delivered) {
        requeue(pending);
        return;
      }
      pending.queuedAfterDisconnect = false;
    }
  }

  function settlePending(pending: PendingRunnerCommand): void {
    settle(pending.command.id, pending);
  }

  function authorizedForRunner(
    runnerId: string,
    commandId: string,
  ): PendingRunnerCommand | undefined {
    const pending = pendingCommands.get(commandId);
    return pending?.runnerId === runnerId && requireAuthorization(pending)
      ? pending
      : undefined;
  }

  function authorizedInFlight(
    ...parameters: readonly [runnerId: string, commandId: string]
  ): PendingRunnerCommand | undefined {
    const pending = authorizedForRunner(...parameters);
    if (pending?.phase !== "in_flight") {
      return undefined;
    }
    return pending;
  }

  function isActive(runnerId: string, commandId: string): boolean {
    return authorizedForRunner(runnerId, commandId) !== undefined;
  }

  function matchingPending(
    matches: (pending: PendingRunnerCommand) => boolean,
  ): PendingRunnerCommand[] {
    return matchingRunnerCommands(pendingCommands, matches);
  }

  function sessionPending(sessionId: string): PendingRunnerCommand[] {
    return matchingPending(
      ({ command }) => command.sessionId === sessionId,
    );
  }

  function pendingToolProgress(sessionId: string): readonly RestartProgressTool[] {
    return countRestartProgressTools(
      sessionPending(sessionId).map(({ command }) => command.tool),
    );
  }

  function sessionCommandPhase(
    sessionId: string,
  ): "in_flight" | "queued" | "runner_disconnected" | undefined {
    const commands = sessionPending(sessionId);
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

  function settleAuthorized(
    runnerId: string,
    commandId: string,
    validate?: (pending: PendingRunnerCommand) => boolean,
  ): PendingRunnerCommand | undefined {
    const pending = authorizedInFlight(runnerId, commandId);
    return pending === undefined || validate?.(pending) === false
      ? undefined
      : pending;
  }

  function stream(
    runnerId: string,
    commandId: string,
    delta: RunnerCommandOutputDelta,
  ): boolean {
    const pending = settleAuthorized(
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

  function complete(
    runnerId: string,
    commandId: string,
    result: RunnerCommandResult,
  ): boolean {
    const pending = settleAuthorized(runnerId, commandId);
    if (pending === undefined) {
      return false;
    }
    settlePending(pending);
    pending.resolve(result);
    return true;
  }

  function rejectMatching(
    matches: (pending: PendingRunnerCommand) => boolean,
    error: () => Error,
  ): readonly RejectedCommand[] {
    const matching = [...pendingCommands.values()]
      .filter(matches)
      .map((pending) => ({ command: pending.command, error: error() }));
    for (const rejected of matching) {
      reject(rejected.command.id, rejected.error);
    }
    return matching;
  }

  function runnerConnectionGeneration(runnerId: string): number {
    return runnerConnectionGenerations.get(runnerId) ?? 0;
  }

  function replaceRunnerConnection(
    runnerId: string,
    replacedGeneration = runnerConnectionGeneration(runnerId),
  ): number {
    if (runnerConnectionGeneration(runnerId) !== replacedGeneration) {
      return runnerConnectionGeneration(runnerId);
    }
    runnerConnectionGenerations.set(runnerId, replacedGeneration + 1);
    const inFlight = matchingPending(
      ({ connectionGeneration, phase, runnerId: assignedRunner }) =>
        assignedRunner === runnerId &&
        phase === "in_flight" &&
        connectionGeneration === replacedGeneration,
    );
    for (const pending of inFlight) {
      reject(
        pending.command.id,
        createRunnerDisconnectedError(
          "The runner connection was superseded before the command returned",
        ),
        false,
      );
    }
    return replacedGeneration + 1;
  }

  function disconnectRunner(runnerId: string, retry = true): void {
    const disconnected = matchingPending(
      ({ phase, runnerId: assignedRunner }) =>
        assignedRunner === runnerId && phase === "in_flight",
    );
    if (!retry) {
      for (const pending of disconnected) {
        reject(pending.command.id, createRunnerDisconnectedError());
      }
      return;
    }
    for (const pending of disconnected.toReversed()) {
      pending.nextSequence = 0;
      pending.queuedAfterDisconnect = true;
      requeue(pending);
    }
  }

  function runnerRemoved(runnerId: string): readonly RejectedCommand[] {
    return rejectMatching(
      (pending) => pending.runnerId === runnerId,
      () => abortRunnerCommand("The assigned runner was removed"),
    );
  }

  function cancelMatching(
    matches: (pending: PendingRunnerCommand) => boolean,
    message: string,
  ): readonly RunnerToolCommand[] {
    return rejectMatching(matches, () => abortRunnerCommand(message)).map(
      ({ command }) => command,
    );
  }

  function cancelSessionGeneration(
    sessionId: string,
    generation: number,
  ): readonly RunnerToolCommand[] {
    return cancelMatching(
      (pending) =>
        pending.generation === generation &&
        pending.command.sessionId === sessionId,
      "The session tools changed",
    );
  }

  function cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[] {
    return cancelMatching(
      (pending) => pending.command.sessionId === sessionId,
      "The agent session was stopped",
    );
  }

  function rejectUnauthorized(pending: PendingRunnerCommand): void {
    reject(
      pending.command.id,
      abortRunnerCommand("The agent session was stopped"),
    );
  }

  function reject(commandId: string, error: Error, publishCancellation = true): void {
    const pending = pendingCommands.get(commandId);
    if (pending === undefined) {
      return;
    }

    const runnerMayStillBeExecuting =
      pending.phase === "in_flight" || pending.queuedAfterDisconnect;
    if (publishCancellation && runnerMayStillBeExecuting) {
      if (pending.queuedAfterDisconnect) {
        survival.recordCancellation(pending.runnerId, commandId);
      }
      if (cancelCommand !== undefined) {
        const cancel = cancelCommand;
        ignoreRunnerCommandCleanupError(() => {
          cancel(pending.runnerId, commandId);
        });
      }
    }
    settle(commandId, pending);
    pending.reject(error);
  }

  function settle(commandId: string, pending: PendingRunnerCommand): void {
    settlePendingRunnerCommand(
      pendingCommands,
      delivery,
      commandId,
      pending,
    );
  }
  return { dispatch, take, deliverCancellationTombstones, acknowledgeCancellation, registerRunnerProcess, commitRunnerProcess, deliverRunnerCommands, deliverQueued, isActive, pendingToolProgress, sessionCommandPhase, stream, complete, runnerConnectionGeneration, replaceRunnerConnection, disconnectRunner, runnerRemoved, cancelSessionGeneration, cancelSessionCommands };
}
