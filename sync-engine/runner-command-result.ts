import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";

export function completedRunnerCommandResult(
  output: string,
): RunnerCommandResult {
  return {
    output,
    state: output.startsWith("Error: ") ? "failed" : "completed",
  };
}
