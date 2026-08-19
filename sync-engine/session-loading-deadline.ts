import {
  formatGlobalToolExecutionLimit,
  toolExecutionLimitMilliseconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";

function loadingTimeLimitMessage(settings: ToolSettings): string {
  return `Loading session context was canceled after reaching the ${formatGlobalToolExecutionLimit(settings)}.`;
}

export async function withLoadingDeadline<Result>(
  runtimeSignal: AbortSignal,
  settings: ToolSettings,
  execute: (signal: AbortSignal) => Promise<Result>,
  preservesError: (error: unknown) => boolean,
): Promise<Result> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(
      new DOMException(loadingTimeLimitMessage(settings), "TimeoutError"),
    );
  }, toolExecutionLimitMilliseconds(settings));
  const completed = new AbortController();
  const loadingSignal = AbortSignal.any([
    runtimeSignal,
    deadline.signal,
    completed.signal,
  ]);
  try {
    return await execute(loadingSignal);
  } catch (error) {
    if (
      deadline.signal.aborted &&
      !runtimeSignal.aborted &&
      !preservesError(error)
    ) {
      throw deadline.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    completed.abort();
  }
}
