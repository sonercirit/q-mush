import { throwIfAgentAborted } from "../shared/agent-loop.ts";
import {
  toolExecutionLimitSeconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { abortSignalError } from "../shared/validation.ts";

// Validation shares the per-run setting; the outer wrapper owns the deadline.
const MILLISECONDS_PER_SECOND = 1_000;

function requestedDuration(
  arguments_: Readonly<Record<string, unknown>>,
  settings: ToolSettings,
): number {
  if (Object.keys(arguments_).length !== 1) {
    throw new Error("The sleep arguments are invalid");
  }
  const durationSeconds = arguments_["durationSeconds"];
  const maximumDurationSeconds = toolExecutionLimitSeconds(settings);
  if (
    typeof durationSeconds !== "number" ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maximumDurationSeconds
  ) {
    throw new Error(
      `Tool argument durationSeconds must be a positive integer no greater than ${String(maximumDurationSeconds)}`,
    );
  }
  return durationSeconds * MILLISECONDS_PER_SECOND;
}

function sleepResult(
  expectedMilliseconds: number,
  actualMilliseconds: number,
  steeringArrived: boolean,
): string {
  const timing = `actual ${String(actualMilliseconds)} ms, expected ${String(expectedMilliseconds)} ms`;
  return steeringArrived
    ? `Steering arrived; woke early (${timing}).`
    : `Slept for the full duration (${timing}).`;
}

export async function executeSessionSleepTool(
  arguments_: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  hasPendingSteeringInput: () => boolean,
  waitForSteeringInput: (signal: AbortSignal) => Promise<void>,
  now: () => number,
  settings: ToolSettings,
): Promise<string> {
  const expectedMilliseconds = requestedDuration(arguments_, settings);
  const startedAt = now();
  throwIfAgentAborted(signal);
  const controller = new AbortController();
  const sleepSignal = AbortSignal.any([signal, controller.signal]);
  const ignoreInternalAbort = (error: unknown): boolean => {
    if (!controller.signal.aborted) {
      throw error;
    }
    throwIfAgentAborted(signal);
    return false;
  };
  const steering = waitForSteeringInput(sleepSignal).then(
    () => true,
    ignoreInternalAbort,
  );
  try {
    if (hasPendingSteeringInput()) {
      return sleepResult(expectedMilliseconds, now() - startedAt, true);
    }
    // The global timer (not node:timers/promises) keeps this fake-timer
    // testable; abort clears it and resolves through the shared handler.
    const completed = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        sleepSignal.removeEventListener("abort", aborted);
        resolve(false);
      }, expectedMilliseconds);
      const aborted = (): void => {
        clearTimeout(timer);
        reject(abortSignalError(sleepSignal, "The sleep was aborted"));
      };
      sleepSignal.addEventListener("abort", aborted, { once: true });
    }).catch(ignoreInternalAbort);
    const steeringArrived = await Promise.race([steering, completed]);
    throwIfAgentAborted(signal);
    return sleepResult(
      expectedMilliseconds,
      now() - startedAt,
      steeringArrived,
    );
  } finally {
    controller.abort();
  }
}
