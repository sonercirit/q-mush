import { afterEach, describe, expect, test, vi } from "vitest";
import { MAXIMUM_TOOL_EXECUTION_MS } from "../../shared/tool-limits.ts";
import { executeToolWithinTimeLimit } from "../session-tool-time-limit.ts";
import { expectNoTimers } from "./timer-test-helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function hangingExecute(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function nonCooperativeExecute(): Promise<never> {
  return new Promise<never>(() => {
    // Intentionally never settles: the execution ignores cancellation.
  });
}

async function expectTimedOutRun(
  execute: Parameters<typeof executeToolWithinTimeLimit>[0],
  outer: AbortController,
): Promise<void> {
  const result = executeToolWithinTimeLimit(execute, outer.signal);
  await vi.advanceTimersByTimeAsync(MAXIMUM_TOOL_EXECUTION_MS);
  await expect(result).resolves.toMatchObject({ state: "timed-out" });
}

function timedOutOuterController(): AbortController {
  vi.useFakeTimers();
  return new AbortController();
}

describe("global tool time limit", () => {
  test("passes fast results through unchanged", async () => {
    const outer = new AbortController();

    await expect(
      executeToolWithinTimeLimit(
        () => Promise.resolve({ output: "done", state: "completed" }),
        outer.signal,
      ),
    ).resolves.toEqual({ output: "done", state: "completed" });
  });

  test("fails a hung tool call at the limit and aborts its signal", async () => {
    const outer = timedOutOuterController();
    let toolSignal: AbortSignal | undefined;

    const result = executeToolWithinTimeLimit((signal) => {
      toolSignal = signal;
      return hangingExecute(signal);
    }, outer.signal);
    await vi.advanceTimersByTimeAsync(MAXIMUM_TOOL_EXECUTION_MS - 1);
    expect(toolSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      output:
        "Error: the tool call was canceled after exceeding the global 30-minute limit. Cancellation is best-effort after a filesystem mutation begins, so verify its result before retrying.",
      state: "timed-out",
    });
    expect(toolSignal?.aborted).toBe(true);
    expectNoTimers();
  });

  test("an outer abort still rejects instead of reporting a timeout", async () => {
    const outer = timedOutOuterController();

    const result = executeToolWithinTimeLimit(hangingExecute, outer.signal);
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
      executeToolWithinTimeLimit(nonCooperativeExecute, outer.signal),
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

  test("a normal completion aborts the combined signal it handed out", async () => {
    const outer = new AbortController();
    let combined: AbortSignal | undefined;

    await executeToolWithinTimeLimit((signal) => {
      combined = signal;
      return Promise.resolve({ output: "done", state: "completed" });
    }, outer.signal);

    // A straggler still listening on the combined signal must not retain
    // the long-lived session signal after its call settled; settle()
    // aborts the composite to release it.
    expect(combined?.aborted).toBe(true);
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
