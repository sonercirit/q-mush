import type { ToolSettings } from "../shared/tool-limits.ts";
import { boundToolResult } from "../shared/tool-output-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import {
  boundStructuredSessionToolOutput,
  isStructuredSessionToolName,
} from "./session-structured-tool-output.ts";

/** The engine's authoritative final model-facing result boundary. */
export function boundSessionToolOutput(
  result: RunnerCommandResult,
  settings: ToolSettings,
  toolName?: string,
): RunnerCommandResult {
  if (isStructuredSessionToolName(toolName)) {
    const output = boundStructuredSessionToolOutput(
      result.output,
      settings.outputLimitCharacters,
      toolName,
    );
    if (output !== undefined) {
      return output === result.output ? result : { ...result, output };
    }
  }
  return boundToolResult(result, settings);
}
