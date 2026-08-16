import {
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_EXECUTION_MS,
} from "../shared/tool-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import { abortSignalError } from "../shared/validation.ts";

const TIME_LIMIT_MESSAGE = `Error: the tool call was canceled after exceeding the global ${String(MAXIMUM_TOOL_EXECUTION_MINUTES)}-minute limit. Cancellation is best-effort after a filesystem mutation begins, so verify its result before retrying.`;

/**
 * Bounds one tool call to the global execution time limit. The execute
 * callback receives a signal that aborts at the limit (in addition to the
 * outer signal), so runner commands and skills cancel their work; if the
 * call still does not settle, the race resolves as a failed tool result
 * instead of hanging the step. Native filesystem mutations cannot be rolled
 * back: after one begins, cancellation is best-effort and the mutation may
 * still land. An outer abort rejects immediately with the outer reason even
 * when the execution ignores cancellation; late settlement of an abandoned
 * call is swallowed.
 */
export function executeToolWithinTimeLimit(
  execute: (signal: AbortSignal) => Promise<RunnerCommandResult>,
  outerSignal: AbortSignal,
): Promise<RunnerCommandResult> {
  const timeoutController = new AbortController();
  const callSignal = AbortSignal.any([outerSignal, timeoutController.signal]);
  return new Promise<RunnerCommandResult>((resolve, reject) => {
    const rejectAborted = () => {
      // Error-valued reasons are preserved; non-Error reasons intentionally
      // fall back to the loop's AbortError wording for stable classification.
      reject(abortSignalError(outerSignal, "The agent session was stopped"));
    };
    if (outerSignal.aborted) {
      rejectAborted();
      return;
    }
    // Late runner deltas for a call already reported timed-out are dropped:
    // the stream state machine rejects every transition from a terminal state.
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException("The tool call timed out", "TimeoutError"),
      );
      // A non-cooperative execution may never settle: release the outer
      // listener here so the timed-out call leaks nothing.
      outerSignal.removeEventListener("abort", onOuterAbort);
      resolve({ output: TIME_LIMIT_MESSAGE, state: "timed-out" });
    }, MAXIMUM_TOOL_EXECUTION_MS);
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      // Abort the composite too: a straggler that ignored cancellation and
      // kept listeners on the call signal must not retain the
      // long-lived session signal after its call settled.
      timeoutController.abort(
        new DOMException("The tool call settled", "AbortError"),
      );
      outerSignal.removeEventListener("abort", onOuterAbort);
      finish();
    };
    const onOuterAbort = () => {
      settle(rejectAborted);
    };
    outerSignal.addEventListener("abort", onOuterAbort);
    const run = async (): Promise<void> => {
      try {
        const result = await execute(callSignal);
        settle(() => {
          resolve(result);
        });
      } catch (error) {
        // If execution rejects because the outer signal fired, preserve the
        // outer reason even when the operation supplied a different error.
        const failure = outerSignal.aborted
          ? abortSignalError(outerSignal, "The agent session was stopped")
          : error;
        // The timer callback aborts and resolves synchronously, so a
        // cancellation rejection always lands after the timed-out result;
        // rejecting an already-settled promise is a harmless no-op that
        // still marks the rejection handled.
        settle(() => {
          if (failure instanceof Error) {
            reject(failure);
            return;
          }
          reject(new Error(String(failure)));
        });
      }
    };
    void run();
  });
}
