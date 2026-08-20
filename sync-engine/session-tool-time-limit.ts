import {
  formatGlobalToolExecutionLimit,
  toolExecutionLimitMilliseconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import { abortSignalError, errorFromUnknown } from "../shared/validation.ts";

function timeLimitMessage(settings: ToolSettings): string {
  return `Error: the tool call was canceled after reaching the ${formatGlobalToolExecutionLimit(settings)}. Cancellation is best-effort after a filesystem mutation begins, so verify its result before retrying.`;
}

/**
 * The sole execution deadline for model-facing tool calls. The execution starts
 * before the deadline timer is registered so work completing at the exact
 * boundary (notably a maximum-duration sleep) wins coherently. The first
 * terminal event wins, its abort reason is preserved, cleanup is idempotent,
 * and late fulfillment or rejection remains observed.
 */
export function executeToolWithinTimeLimit(
  execute: (signal: AbortSignal) => Promise<RunnerCommandResult>,
  outerSignal: AbortSignal,
  settings: ToolSettings,
): Promise<RunnerCommandResult> {
  if (outerSignal.aborted) {
    return Promise.reject(
      abortSignalError(outerSignal, "The agent session was stopped"),
    );
  }
  const callController = new AbortController();
  return new Promise<RunnerCommandResult>((resolve, reject) => {
    let settled = false;
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    const cleanup = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      outerSignal.removeEventListener("abort", onOuterAbort);
    };
    const reserveSettlement = (): boolean => {
      if (settled) return false;
      settled = true;
      cleanup();
      return true;
    };
    const onOuterAbort = (): void => {
      const reason = abortSignalError(
        outerSignal,
        "The agent session was stopped",
      );
      callController.abort(reason);
      if (reserveSettlement()) reject(reason);
    };
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });

    let execution: Promise<RunnerCommandResult>;
    try {
      execution = execute(callController.signal);
    } catch (error) {
      execution = Promise.reject(errorFromUnknown(error));
    }
    void execution.then(
      (result) => {
        if (!reserveSettlement()) return;
        resolve(result);
        callController.abort(
          new DOMException("The tool call settled", "AbortError"),
        );
      },
      (error: unknown) => {
        const failure = outerSignal.aborted
          ? abortSignalError(outerSignal, "The agent session was stopped")
          : errorFromUnknown(error);
        if (!reserveSettlement()) return;
        reject(failure);
        callController.abort(failure);
      },
    );
    if (outerSignal.aborted) return;
    state.timer = setTimeout(() => {
      const reason = new DOMException(
        "The tool call timed out",
        "TimeoutError",
      );
      callController.abort(reason);
      if (!reserveSettlement()) return;
      resolve({ output: timeLimitMessage(settings), state: "timed-out" });
    }, toolExecutionLimitMilliseconds(settings));
  });
}
