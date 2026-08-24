import type { RestartProgressTool } from "./restart-progress.ts";
import type { RunnerCommandSurvivalOptions } from "./runner-command-survival.ts";
import type {
  DispatchRunnerToolCommand,
  RunnerCommandOutputDelta,
  RunnerCommandStream,
  RunnerCommandTransport,
  RunnerToolCommand,
} from "./runner-command.ts";
import type { RunnerCommandResult } from "./tool-stream.ts";

export interface RunnerCommandBrokerOptions
  extends RunnerCommandSurvivalOptions, RunnerCommandTransport {}

export interface RejectedCommand {
  readonly command: RunnerToolCommand;
  readonly error: Error;
}

type DispatchCommand = (
  input: DispatchRunnerToolCommand,
  signal?: AbortSignal,
  stream?: RunnerCommandStream,
) => Promise<RunnerCommandResult>;
export type DeliverCommandArguments = [
  runnerId: string,
  processNonce: string | undefined,
  deliver: (command: RunnerToolCommand) => boolean,
  deliverCancellation: (commandId: string) => boolean,
  connectionGeneration?: number,
];
type DeliverCommands = (...parameters: DeliverCommandArguments) => boolean;

export interface RunnerCommandBroker {
  dispatch: DispatchCommand;
  take(runnerId: string): RunnerToolCommand | undefined;
  deliverCancellationTombstones(
    runnerId: string,
    deliver: (commandId: string) => boolean,
  ): boolean;
  acknowledgeCancellation(runnerId: string, commandId: string): boolean;
  registerRunnerProcess(runnerId: string, processNonce?: string): boolean;
  commitRunnerProcess(runnerId: string, processNonce?: string): void;
  deliverRunnerCommands: DeliverCommands;
  deliverQueued(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
    connectionGeneration?: number,
    excludedCommandIds?: ReadonlySet<string>,
  ): void;
  isActive(runnerId: string, commandId: string): boolean;
  pendingToolProgress(sessionId: string): readonly RestartProgressTool[];
  sessionCommandPhase(
    sessionId: string,
  ): "in_flight" | "queued" | "runner_disconnected" | undefined;
  stream(
    runnerId: string,
    commandId: string,
    delta: RunnerCommandOutputDelta,
  ): boolean;
  complete(
    runnerId: string,
    commandId: string,
    result: RunnerCommandResult,
  ): boolean;
  runnerConnectionGeneration(runnerId: string): number;
  replaceRunnerConnection(
    runnerId: string,
    replacedGeneration?: number,
  ): number;
  disconnectRunner(runnerId: string, retry?: boolean): void;
  runnerRemoved(runnerId: string): readonly RejectedCommand[];
  cancelSessionGeneration(
    sessionId: string,
    generation: number,
  ): readonly RunnerToolCommand[];
  cancelSessionCommands(sessionId: string): readonly RunnerToolCommand[];
}
