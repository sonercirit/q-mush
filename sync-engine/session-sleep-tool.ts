import { setTimeout } from "node:timers/promises";
import { throwIfAgentAborted } from "../shared/agent-loop.ts";

const MAXIMUM_SLEEP_DURATION_MS = 3_600_000;

function requestedDuration(
  arguments_: Readonly<Record<string, unknown>>,
): number {
  if (Object.keys(arguments_).length !== 1) {
    throw new Error("The sleep arguments are invalid");
  }
  const durationMs = arguments_["durationMs"];
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAXIMUM_SLEEP_DURATION_MS
  ) {
    throw new Error(
      `Tool argument durationMs must be a positive integer no greater than ${String(MAXIMUM_SLEEP_DURATION_MS)}`,
    );
  }
  return durationMs;
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
  now: () => number = Date.now,
): Promise<string> {
  const expectedMilliseconds = requestedDuration(arguments_);
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
    const completed = setTimeout(expectedMilliseconds, false, {
      signal: sleepSignal,
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
