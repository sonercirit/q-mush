import type { ToolSettings } from "../tool-limits.ts";

export const CONFIGURED_TOOL_SETTINGS: ToolSettings = Object.freeze({
  executionLimitMinutes: 7,
  outputLimitCharacters: 12_345,
});
