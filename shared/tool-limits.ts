import {
  MAXIMUM_TOOL_OUTPUT_KILOBYTES,
  MAXIMUM_TOOL_OUTPUT_LINES,
} from "./tool-output-limits.ts";

export const MAXIMUM_TOOL_EXECUTION_MINUTES = 30;
export const MAXIMUM_TOOL_EXECUTION_SECONDS =
  MAXIMUM_TOOL_EXECUTION_MINUTES * 60;
export const MAXIMUM_TOOL_EXECUTION_MS = MAXIMUM_TOOL_EXECUTION_SECONDS * 1_000;

// One authoritative statement of the global limits, shared by the agent
// system prompt and the tool-picker UI so individual tool descriptions do
// not repeat them.
export const SHARED_TOOL_LIMITS_STATEMENT = `Every tool call is limited to ${String(MAXIMUM_TOOL_EXECUTION_MINUTES)} minutes; longer runs are canceled. Tool output is limited to ${MAXIMUM_TOOL_OUTPUT_LINES.toLocaleString("en-US")} lines or ${MAXIMUM_TOOL_OUTPUT_KILOBYTES.toLocaleString("en-US")} KB and larger outputs are truncated or spilled to a file. A parallel batch shares its single call's time budget. ask_questions pauses the session instead, so the wait for an answer has no time limit.`;
