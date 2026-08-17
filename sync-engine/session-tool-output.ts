import {
  DEFAULT_TOOL_SETTINGS,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { boundToolResult } from "../shared/tool-output-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";

/** The engine's authoritative final model-facing result boundary. */
export function boundSessionToolOutput(
  result: RunnerCommandResult,
  settings: ToolSettings = DEFAULT_TOOL_SETTINGS,
): RunnerCommandResult {
  return boundToolResult(result, settings);
}
