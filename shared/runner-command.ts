import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

export type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "./tool-stream.ts";

export function failedRunnerCommandResult(error: unknown): RunnerCommandResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    output: `Error: ${detail}`,
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
  readonly executionLimitSeconds?: number;
  readonly id: string;
  readonly outputLimitCharacters?: number;
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
  readonly queueIfUnavailable?: boolean;
  readonly runnerId: string;
}

export interface RunnerCommandTransport {
  readonly cancel?: (runnerId: string, commandId: string) => void;
  readonly commandId?: () => string;
  readonly deliver?: (runnerId: string, command: RunnerToolCommand) => boolean;
}

export type RunnerCommandStream = (delta: RunnerCommandOutputDelta) => void;
