import { isRecord } from "./auth-model.ts";
import { MAXIMUM_RUNNER_RESULT_OUTPUT_CHARACTERS } from "./realtime-limits.ts";

export const DEFAULT_TOOL_OUTPUT_CHARACTERS = 20_000;

export const DEFAULT_TOOL_SETTINGS: ToolSettings = Object.freeze({
  executionLimitMinutes: 30,
  outputLimitCharacters: DEFAULT_TOOL_OUTPUT_CHARACTERS,
});

const MILLISECONDS_PER_MINUTE = 60_000;
const MAXIMUM_TIMER_MILLISECONDS = 2_147_483_647;
export const MAXIMUM_TOOL_EXECUTION_MINUTES = Math.floor(
  MAXIMUM_TIMER_MILLISECONDS / MILLISECONDS_PER_MINUTE,
);
export const MINIMUM_TOOL_OUTPUT_CHARACTERS = 100;
/**
 * A runner result is JSON-framed on the 128 MiB realtime transport. This is
 * derived from the worst-case JSON encoding, including framing and the one
 * overflow-detection code point; it is not a separate model-facing tunable.
 */
export const MAXIMUM_TOOL_OUTPUT_CHARACTERS =
  MAXIMUM_RUNNER_RESULT_OUTPUT_CHARACTERS;

export interface ToolSettings {
  readonly executionLimitMinutes: number;
  readonly outputLimitCharacters: number;
}

function validInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isToolSettings(value: unknown): value is ToolSettings {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    validInteger(
      value["executionLimitMinutes"],
      1,
      MAXIMUM_TOOL_EXECUTION_MINUTES,
    ) &&
    validInteger(
      value["outputLimitCharacters"],
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
      MAXIMUM_TOOL_OUTPUT_CHARACTERS,
    )
  );
}

export function readToolSettings(value: unknown): ToolSettings | undefined {
  return isToolSettings(value)
    ? {
        executionLimitMinutes: value.executionLimitMinutes,
        outputLimitCharacters: value.outputLimitCharacters,
      }
    : undefined;
}

export function toolExecutionLimitMilliseconds(settings: ToolSettings): number {
  return settings.executionLimitMinutes * MILLISECONDS_PER_MINUTE;
}

export function toolExecutionLimitSeconds(settings: ToolSettings): number {
  return settings.executionLimitMinutes * 60;
}

export function formatToolLimitsStatement(settings: ToolSettings): string {
  const minuteLabel =
    settings.executionLimitMinutes === 1 ? "minute" : "minutes";
  return `Every tool call, including sleep, is limited to ${settings.executionLimitMinutes.toLocaleString("en-US")} ${minuteLabel}; longer calls are canceled. Every model-facing tool result is limited to ${settings.outputLimitCharacters.toLocaleString("en-US")} Unicode characters and larger results are truncated with one notice. A parallel batch shares its single call's time and output budgets. ask_questions pauses the session instead of executing tool work, so the wait for an answer has no deadline.`;
}
