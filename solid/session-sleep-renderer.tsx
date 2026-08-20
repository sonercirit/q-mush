import type { JSX } from "solid-js";
import { parseOptionalJsonRecord } from "../shared/json-record.ts";
import { formatSessionTime } from "../shared/session-timing.ts";
import {
  toolExecutionLimitSeconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { renderStructuredCode } from "./session-syntax.tsx";

const MILLISECONDS_PER_SECOND = 1_000;
// Display-only sanity bound: use whichever bound is larger. Transcripts
// recorded before the schema maximum changed from 3,600s to the global
// tool limit can legitimately contain hour-long sleeps.
const HISTORICAL_MAXIMUM_SLEEP_DURATION_SECONDS = 3_600;

function formatSleepDuration(milliseconds: number): string {
  return formatSessionTime(milliseconds).replace(/ 0[ms]$/u, "");
}

function sleepDurationMilliseconds(
  arguments_: string,
  settings: ToolSettings,
): number | undefined {
  const maximumSeconds = Math.max(
    HISTORICAL_MAXIMUM_SLEEP_DURATION_SECONDS,
    toolExecutionLimitSeconds(settings),
  );
  const maximumMilliseconds = maximumSeconds * MILLISECONDS_PER_SECOND;
  const parsed = parseOptionalJsonRecord(arguments_);
  if (parsed === undefined || Object.keys(parsed).length !== 1) {
    return undefined;
  }

  const durationSeconds = parsed["durationSeconds"];
  if (
    typeof durationSeconds === "number" &&
    Number.isSafeInteger(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds <= maximumSeconds
  ) {
    return durationSeconds * MILLISECONDS_PER_SECOND;
  }

  const durationMilliseconds = parsed["durationMs"];
  return typeof durationMilliseconds === "number" &&
    Number.isSafeInteger(durationMilliseconds) &&
    durationMilliseconds > 0 &&
    durationMilliseconds <= maximumMilliseconds
    ? durationMilliseconds
    : undefined;
}

export function renderToolArguments(
  name: string,
  arguments_: string,
  settings: ToolSettings | undefined,
): JSX.Element {
  const durationMilliseconds =
    name === "sleep" && settings !== undefined
      ? sleepDurationMilliseconds(arguments_, settings)
      : undefined;
  return durationMilliseconds === undefined ? (
    renderStructuredCode(arguments_)
  ) : (
    <p class="rounded-lg border border-cyan-300/20 bg-slate-950/60 px-3 py-2 text-sm text-cyan-100">
      {`Duration: ${formatSleepDuration(durationMilliseconds)}`}
    </p>
  );
}

const SLEEP_RESULT_PATTERN =
  /^(Steering arrived; woke early|Slept for the full duration) \(actual (\d+) ms, expected (\d+) ms\)\.$/u;

export function renderSleepResult(content: string): JSX.Element | undefined {
  const match = SLEEP_RESULT_PATTERN.exec(content);
  if (match === null) {
    return undefined;
  }

  const [, status, actual, expected] = match;
  if (status === undefined || actual === undefined || expected === undefined) {
    return undefined;
  }
  const actualMilliseconds = Number(actual);
  const expectedMilliseconds = Number(expected);
  if (
    !Number.isSafeInteger(actualMilliseconds) ||
    !Number.isSafeInteger(expectedMilliseconds)
  ) {
    return undefined;
  }

  return (
    <div class="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">
      <p>{`${status}.`}</p>
      <p class="mt-1 text-xs text-slate-400">
        {`Actual: ${formatSleepDuration(actualMilliseconds)} · Expected: ${formatSleepDuration(expectedMilliseconds)}`}
      </p>
    </div>
  );
}
