import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitSeconds,
} from "../../shared/tool-limits.ts";
import { executeSessionSleepTool } from "../session-sleep-tool.ts";
import {
  notifySessionSteeringInput,
  waitForSessionSteeringInput,
} from "../session-steering-wakeup.ts";
import { expectNoTimers } from "./timer-test-helpers.ts";

const DEFAULT_EXECUTION_LIMIT_SECONDS = toolExecutionLimitSeconds(
  DEFAULT_TOOL_SETTINGS,
);

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

function inactiveSteering(): boolean {
  return false;
}

function startSleep(
  durationSeconds: number,
  sessionId: string,
  options: {
    readonly pending?: () => boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const signal = options.signal ?? new AbortController().signal;
  return executeSessionSleepTool(
    { durationSeconds },
    signal,
    options.pending ?? inactiveSteering,
    (waitSignal) => waitForSessionSteeringInput(sessionId, waitSignal),
    Date.now,
    DEFAULT_TOOL_SETTINGS,
  );
}

function invalidSleep(
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  return executeSessionSleepTool(
    arguments_,
    new AbortController().signal,
    inactiveSteering,
    () => Promise.resolve(),
    Date.now,
    DEFAULT_TOOL_SETTINGS,
  );
}

function elapsedMilliseconds(output: string): number {
  const match = /actual (\d+) ms/.exec(output);
  if (match === null) {
    throw new Error("Sleep output does not report actual elapsed time");
  }
  return Number(match[1]);
}

describe("session sleep tool", () => {
  test("sleeps for the requested duration and reports actual versus expected", async () => {
    await withFakeTimers(async () => {
      const assertion = expect(startSleep(1, "full")).resolves.toMatch(
        /Slept for the full duration.*actual 1000 ms.*expected 1000 ms/,
      );

      await advance(1_000);
      await assertion;
      expectNoTimers();
    });
  });

  test("returns immediately when steering is already pending", async () => {
    await withFakeTimers(async () => {
      const output = await startSleep(1, "pending", {
        pending: () => true,
      });

      expect(output).toMatch(
        /Steering arrived; woke early.*actual 0 ms.*expected 1000 ms/,
      );
      expectNoTimers();
    });
  });

  test("wakes early for pending steering and reports elapsed versus expected", async () => {
    await withFakeTimers(async () => {
      const sleeping = startSleep(1, "steered");

      await advance(100);
      notifySessionSteeringInput("steered");
      const output = await sleeping;

      expect(output).toMatch(
        /Steering arrived; woke early.*actual 100 ms.*expected 1000 ms/,
      );
      expect(elapsedMilliseconds(output)).toBeLessThan(1_000);
      expectNoTimers();
    });
  });

  test("completes a maximum-duration sleep inside the global tool limit", async () => {
    await withFakeTimers(async () => {
      const maximum = startSleep(DEFAULT_EXECUTION_LIMIT_SECONDS, "maximum");
      await vi.runAllTimersAsync();

      await expect(maximum).resolves.toMatch(/Slept for the full duration/);
      expectNoTimers();
    });
  });

  test("rejects invalid and unreasonably long durations", async () => {
    for (const durationSeconds of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      DEFAULT_EXECUTION_LIMIT_SECONDS + 1,
    ]) {
      await expect(invalidSleep({ durationSeconds })).rejects.toThrow(
        "durationSeconds",
      );
    }
    await expect(invalidSleep({ durationMs: 1_000 })).rejects.toThrow(
      "durationSeconds",
    );
    await expect(
      invalidSleep({ durationSeconds: 1, extra: true }),
    ).rejects.toThrow("arguments");
  });

  test("stops immediately on abort without leaking a timer", async () => {
    await withFakeTimers(async () => {
      const controller = new AbortController();
      const assertion = expect(
        startSleep(1, "stopped", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });

      await advance(100);
      controller.abort();
      await assertion;
      expectNoTimers();
    });
  });
});
