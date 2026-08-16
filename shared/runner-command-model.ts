import type { RunnerCommandResult } from "./tool-stream.ts";

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
export const RUNNER_TOOL_OUTPUT_SPILL_COMMAND = "spill_tool_output";
export const RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT = "content";

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
  readonly queueIfUnavailable?: boolean;
  readonly runnerId: string;
}
