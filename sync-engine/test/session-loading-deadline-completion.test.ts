import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitMilliseconds,
} from "../../shared/tool-limits.ts";
import { withLoadingDeadline } from "../session-loading-deadline.ts";

describe("session loading deadline completion", () => {
  test("aborts consumers and cancels the deadline timer after successful loading", async () => {
    vi.useFakeTimers();
    try {
      let loadingSignal: AbortSignal | undefined;
      let aborts = 0;
      const result = await withLoadingDeadline(
        new AbortController().signal,
        DEFAULT_TOOL_SETTINGS,
        (signal) => {
          loadingSignal = signal;
          signal.addEventListener("abort", () => {
            aborts += 1;
          });
          return Promise.resolve("loaded");
        },
        () => false,
      );

      expect(result).toBe("loaded");
      expect(loadingSignal).toMatchObject({ aborted: true });
      expect(aborts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(
        toolExecutionLimitMilliseconds(DEFAULT_TOOL_SETTINGS),
      );
      expect({ aborts, timers: vi.getTimerCount() }).toEqual({
        aborts: 1,
        timers: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
