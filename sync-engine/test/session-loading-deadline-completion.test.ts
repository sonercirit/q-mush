import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitMilliseconds,
} from "../../shared/tool-limits.ts";
import { withLoadingDeadline } from "../session-loading-deadline.ts";

describe("session loading deadline completion", () => {
  test.each([
    { outcome: "successful", rejection: undefined },
    { outcome: "rejected", rejection: new Error("loading failed") },
  ])(
    "aborts consumers and cancels the deadline timer after $outcome loading",
    async ({ rejection }) => {
      vi.useFakeTimers();
      try {
        let loadingSignal: AbortSignal | undefined;
        let aborts = 0;
        const loading = withLoadingDeadline(
          new AbortController().signal,
          DEFAULT_TOOL_SETTINGS,
          (signal) => {
            loadingSignal = signal;
            signal.addEventListener("abort", () => {
              aborts += 1;
            });
            return rejection === undefined
              ? Promise.resolve("loaded")
              : Promise.reject(rejection);
          },
          () => false,
        );

        if (rejection === undefined)
          await expect(loading).resolves.toBe("loaded");
        else await expect(loading).rejects.toBe(rejection);
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
    },
  );
});
