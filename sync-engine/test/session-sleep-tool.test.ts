import { describe, expect, test, vi } from "vitest";
import { MAXIMUM_TOOL_EXECUTION_SECONDS } from "../../shared/tool-limits.ts";
import { executeSessionSleepTool } from "../session-sleep-tool.ts";
import {
  notifySessionSteeringInput,
  waitForSessionSteeringInput,
} from "../session-steering-wakeup.ts";
import { expectNoTimers } from "./timer-test-helpers.ts";

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
      const maximum = startSleep(MAXIMUM_TOOL_EXECUTION_SECONDS, "maximum");
      await vi.runAllTimersAsync();

      await expect(maximum).resolves.toMatch(/Slept for the full duration/);
      expectNoTimers();
    });
  });

  test("rejects invalid and unreasonably long durations", async () => {
    const signal = new AbortController().signal;
    const wait = () => Promise.resolve();
    for (const durationSeconds of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      MAXIMUM_TOOL_EXECUTION_SECONDS + 1,
    ]) {
      await expect(
        executeSessionSleepTool(
          { durationSeconds },
          signal,
          inactiveSteering,
          wait,
        ),
      ).rejects.toThrow("durationSeconds");
    }
    await expect(
      executeSessionSleepTool(
        { durationMs: 1_000 },
        signal,
        inactiveSteering,
        wait,
      ),
    ).rejects.toThrow("durationSeconds");
    await expect(
      executeSessionSleepTool(
        { durationSeconds: 1, extra: true },
        signal,
        inactiveSteering,
        wait,
      ),
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
