import {
  toolExecutionLimitMilliseconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { timeLimitMessage } from "./session-tool-time-limit.ts";

export async function withLoadingDeadline<Result>(
  runtimeSignal: AbortSignal,
  settings: ToolSettings,
  execute: (signal: AbortSignal) => Promise<Result>,
  preservesError: (error: unknown) => boolean,
): Promise<Result> {
  const deadline = AbortSignal.timeout(
    toolExecutionLimitMilliseconds(settings),
  );
  try {
    return await execute(AbortSignal.any([runtimeSignal, deadline]));
  } catch (error) {
    if (deadline.aborted && !runtimeSignal.aborted && !preservesError(error)) {
      const timeout = new DOMException(
        timeLimitMessage(settings),
        "TimeoutError",
      );
      Object.defineProperty(timeout, "cause", { value: deadline.reason });
      throw timeout;
    }
    throw error;
  }
}
