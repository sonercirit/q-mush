import type { RunnerCommandResult } from "../shared/tool-stream.ts";

export function completedRunnerCommandResult(
  output: string,
): RunnerCommandResult {
  return {
    output,
    state: output.startsWith("Error: ") ? "failed" : "completed",
  };
}
