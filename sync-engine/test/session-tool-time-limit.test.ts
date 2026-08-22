import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitMilliseconds,
} from "../../shared/tool-limits.ts";
import {
  boundToolResult,
  unicodeCharacterCount,
} from "../../shared/tool-output-limits.ts";
import { executeSessionSleepTool } from "../session-sleep-tool.ts";
import { waitForSessionSteeringInput } from "../session-steering-wakeup.ts";
import { executeToolWithinTimeLimit } from "../session-tool-time-limit.ts";
import { expectNoTimers } from "./timer-test-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function abortingExecute(
  message = "Aborted",
): (signal: AbortSignal) => Promise<never> {
  return (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException(message, "AbortError"));
      });
    });
}

const hangingExecute = abortingExecute();

function nonCooperativeExecute(): Promise<never> {
  return new Promise<never>(() => {
    // Intentionally never settles: the execution ignores cancellation.
  });
}

function signalCapture() {
  return vi.fn<(signal: AbortSignal) => void>();
}

function lastCapturedSignal(
  capture: ReturnType<typeof signalCapture>,
): AbortSignal {
  const signal = capture.mock.lastCall?.[0];
  if (signal === undefined)
    throw new TypeError("The tool signal was not captured");
  return signal;
}

async function advanceToToolDeadline(
  settings = DEFAULT_TOOL_SETTINGS,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    toolExecutionLimitMilliseconds(settings) - 1,
  );
}

async function expectTimedOutRun(
  execute: Parameters<typeof executeToolWithinTimeLimit>[0],
  outer: AbortController,
): Promise<void> {
  const result = executeToolWithinTimeLimit(
    execute,
    outer.signal,
    DEFAULT_TOOL_SETTINGS,
  );
  await vi.advanceTimersByTimeAsync(
    toolExecutionLimitMilliseconds(DEFAULT_TOOL_SETTINGS),
  );
  await expect(result).resolves.toMatchObject({ state: "timed-out" });
}

function defaultTimedRun(
  execute: Parameters<typeof executeToolWithinTimeLimit>[0],
  outer: AbortController,
) {
  return executeToolWithinTimeLimit(
    execute,
    outer.signal,
    DEFAULT_TOOL_SETTINGS,
  );
}

function timedOutOuterController(): AbortController {
  vi.useFakeTimers();
  return new AbortController();
}

function deadlineSettlement(result: Promise<unknown>): () => boolean {
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  return () => settled;
}

function oneMinuteSettings(
  outputLimitCharacters = DEFAULT_TOOL_SETTINGS.outputLimitCharacters,
) {
  return { executionLimitMinutes: 1, outputLimitCharacters };
}

async function expectPending(result: Promise<unknown>): Promise<void> {
  const settled = deadlineSettlement(result);
  await Promise.resolve();
  expect(settled()).toBe(false);
}

function expectTimeoutResult(
  result: { readonly output: string; readonly state: string },
  outputFragment: string,
): void {
  expect(result.state).toBe("timed-out");
  expect(result.output).toContain(outputFragment);
}

async function advanceAndReadTimeout<Result>(
  result: Promise<Result>,
  milliseconds: number,
): Promise<Result> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  return result;
}

describe("global tool time limit", () => {
  test("passes fast results through unchanged", async () => {
    const outer = new AbortController();

    await expect(
      executeToolWithinTimeLimit(
        () => Promise.resolve({ output: "done", state: "completed" }),
        outer.signal,
        DEFAULT_TOOL_SETTINGS,
      ),
    ).resolves.toEqual({ output: "done", state: "completed" });
  });

  test("lets an exact-boundary sleep complete through the deadline wrapper", async () => {
    vi.useFakeTimers();
    const settings = oneMinuteSettings(1_000);
    const result = executeToolWithinTimeLimit(
      async (signal) => ({
        output: await executeSessionSleepTool(
          { durationSeconds: 60 },
          signal,
          () => false,
          (waitSignal) =>
            waitForSessionSteeringInput("exact-boundary", waitSignal),
          Date.now,
          settings,
        ),
        state: "completed",
      }),
      new AbortController().signal,
      settings,
    );

    await vi.advanceTimersByTimeAsync(60_000);

    const completed = await result;
    expect(completed.state).toBe("completed");
    expect(completed.output).toContain("Slept for the full duration");
    expectNoTimers();
  });

  test("bounds generated timeout output through the finalizer", async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const settings = oneMinuteSettings(100);
    const result = executeToolWithinTimeLimit(
      hangingExecute,
      outer.signal,
      settings,
    ).then((toolResult) => boundToolResult(toolResult, settings));

    const timedOut = await advanceAndReadTimeout(result, 60_000);
    expectTimeoutResult(timedOut, "Tool output truncated");
    expect(unicodeCharacterCount(timedOut.output)).toBe(100);
  });

  test("uses the configured deadline and message", async () => {
    vi.useFakeTimers();
    const settings = { ...DEFAULT_TOOL_SETTINGS, executionLimitMinutes: 7 };
    const deadlineSignal = new AbortController().signal;
    const result = executeToolWithinTimeLimit(
      hangingExecute,
      deadlineSignal,
      settings,
    );
    await advanceToToolDeadline(settings);
    await expectPending(result);
    const timedOut = await advanceAndReadTimeout(result, 1);
    expectTimeoutResult(timedOut, "global 7-minute limit");
    expectNoTimers();
  });

  test("keeps one snapshotted deadline when live settings change", async () => {
    vi.useFakeTimers();
    let liveSettings = {
      ...DEFAULT_TOOL_SETTINGS,
      executionLimitMinutes: 7,
    };
    const snapshot = liveSettings;
    const result = executeToolWithinTimeLimit(
      hangingExecute,
      new AbortController().signal,
      snapshot,
    );

    liveSettings = oneMinuteSettings(liveSettings.outputLimitCharacters);
    await vi.advanceTimersByTimeAsync(60_000);
    await expectPending(result);
    const timedOut = await advanceAndReadTimeout(result, 6 * 60_000);

    expect(timedOut).toMatchObject({ state: "timed-out" });
    expect(liveSettings.executionLimitMinutes).toBe(1);
    expectNoTimers();
  });

  test("fails a hung tool call at the limit and aborts its signal", async () => {
    const outer = timedOutOuterController();
    const callSignal = signalCapture();

    const result = executeToolWithinTimeLimit(
      (signal) => {
        callSignal(signal);
        return hangingExecute(signal);
      },
      outer.signal,
      DEFAULT_TOOL_SETTINGS,
    );
    await advanceToToolDeadline();
    expect(lastCapturedSignal(callSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const timedOut = await result;
    expect(timedOut).toEqual({
      output: `Error: the tool call was canceled after reaching the global ${String(DEFAULT_TOOL_SETTINGS.executionLimitMinutes)}-minute limit. Cancellation is best-effort after a filesystem mutation begins, so verify its result before retrying.`,
      state: "timed-out",
    });
    expect(lastCapturedSignal(callSignal).aborted).toBe(true);
    expectNoTimers();
  });

  test("prefers the outer reason when execution rejects with another abort", async () => {
    const outer = timedOutOuterController();
    const result = defaultTimedRun(abortingExecute("Inner abort"), outer);
    const assertion = expect(result).rejects.toThrow("Outer stop");

    outer.abort(new Error("Outer stop"));
    await assertion;
    expectNoTimers();
  });

  test("an outer abort still rejects instead of reporting a timeout", async () => {
    const outer = timedOutOuterController();

    const result = defaultTimedRun(hangingExecute, outer);
    const assertion = expect(result).rejects.toThrow("Aborted");
    outer.abort(new DOMException("Aborted", "AbortError"));
    await assertion;
    expectNoTimers();
  });

  // The execution ignores its signal and never settles; the outer abort
  // must still reject promptly with the outer reason.
  async function abortedNonCooperativeRun(reason: Error): Promise<unknown> {
    const outer = timedOutOuterController();

    const result = executeToolWithinTimeLimit(
      nonCooperativeExecute,
      outer.signal,
      DEFAULT_TOOL_SETTINGS,
    );
    const captured = result.catch((error: unknown) => error);
    outer.abort(reason);
    const error = await captured;
    expectNoTimers();
    return error;
  }

  test("an outer abort settles a non-cooperative execution immediately", async () => {
    const error = await abortedNonCooperativeRun(
      new Error("Stopped by the user"),
    );

    expect(error).toMatchObject({ message: "Stopped by the user" });
  });

  test("an execution started after an outer abort rejects with the outer reason", async () => {
    const outer = timedOutOuterController();
    outer.abort(new Error("Stopped by the user"));

    await expect(
      executeToolWithinTimeLimit(
        nonCooperativeExecute,
        outer.signal,
        DEFAULT_TOOL_SETTINGS,
      ),
    ).rejects.toThrow("Stopped by the user");
    expectNoTimers();
  });

  test("a restart handoff abort keeps its reason for resumable results", async () => {
    const error = await abortedNonCooperativeRun(
      new DOMException("Restarting", "RestartHandoff"),
    );

    expect(error).toMatchObject({ name: "RestartHandoff" });
  });

  test("a timed-out non-cooperative call releases its outer abort listener", async () => {
    const outer = timedOutOuterController();
    const added = vi.spyOn(outer.signal, "addEventListener");
    const removed = vi.spyOn(outer.signal, "removeEventListener");

    await expectTimedOutRun(nonCooperativeExecute, outer);

    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
    expectNoTimers();
  });

  test("a normal completion aborts the call signal it handed out", async () => {
    const callSignal = signalCapture();
    const outer = new AbortController();

    await executeToolWithinTimeLimit(
      (signal) => {
        callSignal(signal);
        return Promise.resolve({ output: "done", state: "completed" });
      },
      outer.signal,
      DEFAULT_TOOL_SETTINGS,
    );

    // A straggler still listening on the call signal must not retain
    // the long-lived session signal after its call settled; settle()
    // aborts the composite to release it.
    expect(lastCapturedSignal(callSignal).aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  test("a late rejection after the limit does not surface as unhandled", async () => {
    const outer = timedOutOuterController();
    let rejectLater: ((error: Error) => void) | undefined;

    await expectTimedOutRun(
      () =>
        new Promise((_resolve, reject) => {
          rejectLater = reject;
        }),
      outer,
    );

    rejectLater?.(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
