import { Buffer } from "node:buffer";
import {
  aggregateToolStreamState,
  type RunnerCommandResult,
} from "./tool-stream.ts";
import { utf8Prefix } from "./utf8.ts";
import { abortSignalError } from "./validation.ts";

const PARALLEL_CALL_CONCURRENCY = 4;
const MAXIMUM_PARALLEL_CHILD_OUTPUT_BYTES = 50 * 1_024;
const MAXIMUM_PARALLEL_OUTPUT_BYTES = 256 * 1_024;
const PARALLEL_TRUNCATION_MARKER = "[parallel output truncated]";

export type ParallelCallResult =
  | { readonly error: string; readonly recipient_name: string }
  | { readonly output: string; readonly recipient_name: string };

export interface ParallelToolResult {
  readonly canonical: ParallelCallResult;
  readonly state: RunnerCommandResult["state"];
}

export function aggregateParallelToolResults(
  entries: readonly ParallelToolResult[],
): RunnerCommandResult {
  return {
    output: boundedParallelOutput(entries.map(({ canonical }) => canonical)),
    state: aggregateToolStreamState(new Set(entries.map(({ state }) => state))),
  };
}

interface ParallelExecutor<Input, Output> {
  readonly execute: (item: Input, index: number) => Promise<Output>;
  readonly items: readonly Input[];
  readonly signal: AbortSignal | undefined;
}

interface ParallelExecutionState {
  failure: ((error: unknown) => void) | undefined;
  nextIndex: number;
  stopped: boolean;
}

interface ParallelWorkerOptions<Input, Output> extends ParallelExecutor<
  Input,
  Output
> {
  readonly complete: () => void;
  readonly results: ({ readonly value: Output } | undefined)[];
  readonly state: ParallelExecutionState;
}

interface NormalizedParallelResult {
  readonly field: "error" | "output";
  readonly recipientName: string;
  readonly value: string;
}

function parallelError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function ensureParallelActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw abortSignalError(signal, "The operation was stopped");
}

function parallelStopped(state: ParallelExecutionState, error: unknown): void {
  state.stopped = true;
  state.failure?.(error);
}

function stopParallelExecution(
  state: ParallelExecutionState,
  error: unknown,
  complete: () => void,
): void {
  parallelStopped(state, error);
  complete();
}

function parallelWorker<Input, Output>(
  worker: ParallelWorkerOptions<Input, Output>,
): void {
  const { complete, execute, items, results, signal, state } = worker;
  const advance = (): void => {
    if (state.stopped) {
      complete();
      return;
    }

    try {
      ensureParallelActive(signal);
      const index = state.nextIndex;
      const item = items[index];
      if (item === undefined) {
        complete();
        return;
      }
      state.nextIndex += 1;
      let execution: Promise<Output>;
      try {
        execution = execute(item, index);
      } catch (error) {
        stopParallelExecution(state, error, complete);
        return;
      }
      void execution.then(
        (value) => {
          results[index] = { value };
          advance();
        },
        (error: unknown) => {
          stopParallelExecution(state, error, complete);
        },
      );
    } catch (error) {
      stopParallelExecution(state, error, complete);
    }
  };
  advance();
}

function completedParallelResults<Output>(
  results: readonly ({ readonly value: Output } | undefined)[],
): readonly Output[] {
  return results.map((result) => {
    if (result === undefined) {
      throw new Error("Parallel execution did not produce every result");
    }
    return result.value;
  });
}

function waitForParallelExecution<Input, Output>(
  options: ParallelExecutor<Input, Output>,
  results: ({ readonly value: Output } | undefined)[],
  state: ParallelExecutionState,
  workerCount: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completedWorkers = 0;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      state.failure = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(parallelError(error));
      }
    };
    const onAbort = (): void => {
      state.stopped = true;
      if (options.signal !== undefined) {
        finish(abortSignalError(options.signal, "The operation was stopped"));
      }
    };
    const completeWorker = (): void => {
      completedWorkers += 1;
      if (completedWorkers === workerCount) {
        finish();
      }
    };
    state.failure = finish;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    for (let index = 0; index < workerCount; index += 1) {
      parallelWorker({
        ...options,
        complete: completeWorker,
        results,
        state,
      });
    }
  });
}

/**
 * Maps every accepted item in input order. The fixed worker bound limits
 * simultaneous resource use, not the number of items accepted.
 */
export async function mapWithParallelConcurrency<Input, Output>(
  items: readonly Input[],
  execute: (item: Input, index: number) => Promise<Output>,
  signal?: AbortSignal,
): Promise<readonly Output[]> {
  ensureParallelActive(signal);
  const results: ({ readonly value: Output } | undefined)[] = Array.from({
    length: items.length,
  });
  const executor: ParallelExecutor<Input, Output> = { execute, items, signal };
  const state: ParallelExecutionState = {
    failure: undefined,
    nextIndex: 0,
    stopped: false,
  };
  const workerCount = Math.min(PARALLEL_CALL_CONCURRENCY, items.length);
  if (workerCount > 0) {
    await waitForParallelExecution(executor, results, state, workerCount);
  }
  ensureParallelActive(signal);
  return completedParallelResults(results);
}

function truncateParallelText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }

  const suffix = `\n${PARALLEL_TRUNCATION_MARKER}`;
  const prefixBytes = Math.max(
    0,
    maximumBytes - Buffer.byteLength(suffix, "utf8"),
  );
  const prefix = utf8Prefix(value, prefixBytes);
  return prefix.length === 0
    ? PARALLEL_TRUNCATION_MARKER
    : `${prefix}${suffix}`;
}

function normalizeParallelResult(
  result: ParallelCallResult,
): NormalizedParallelResult {
  const field = "error" in result ? "error" : "output";
  const value = "error" in result ? result.error : result.output;
  return {
    field,
    recipientName: result.recipient_name,
    value: truncateParallelText(value, MAXIMUM_PARALLEL_CHILD_OUTPUT_BYTES),
  };
}

function resultValue(
  result: NormalizedParallelResult,
  value: string,
): ParallelCallResult {
  return result.field === "output"
    ? { output: value, recipient_name: result.recipientName }
    : { error: value, recipient_name: result.recipientName };
}

function serializedResult(
  result: NormalizedParallelResult,
  value = result.value,
): string {
  return JSON.stringify(resultValue(result, value));
}

function serializedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function markedPrefix(value: string, maximumPrefixBytes: number): string {
  const prefix = utf8Prefix(value, maximumPrefixBytes);
  return prefix.length === 0
    ? PARALLEL_TRUNCATION_MARKER
    : `${prefix}\n${PARALLEL_TRUNCATION_MARKER}`;
}

function fitSerializedResult(
  result: NormalizedParallelResult,
  maximumBytes: number,
): string {
  const complete = serializedResult(result);
  if (serializedBytes(complete) <= maximumBytes) {
    return complete;
  }

  let lower = 0;
  let upper = Buffer.byteLength(result.value, "utf8");
  let fitted = serializedResult(result, PARALLEL_TRUNCATION_MARKER);
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = serializedResult(
      result,
      markedPrefix(result.value, middle),
    );
    if (serializedBytes(candidate) <= maximumBytes) {
      fitted = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return fitted;
}

function metadataOverflowOutput(resultCount: number): string {
  return JSON.stringify({
    error: `All ${String(resultCount)} parallel calls ran, but their result metadata exceeded the bounded output size.`,
    result_count: resultCount,
  });
}

/** Bounds child and aggregate payloads while retaining every result when able. */
export function boundedParallelOutput(
  results: readonly ParallelCallResult[],
): string {
  const normalized = results.map(normalizeParallelResult);
  const complete = JSON.stringify(results, null, 2);
  if (serializedBytes(complete) <= MAXIMUM_PARALLEL_OUTPUT_BYTES) {
    return complete;
  }

  const minimumParts = normalized.map((result) =>
    serializedResult(result, PARALLEL_TRUNCATION_MARKER),
  );
  const minimumBytes =
    results.length +
    1 +
    minimumParts.reduce((total, part) => total + serializedBytes(part), 0);
  if (minimumBytes > MAXIMUM_PARALLEL_OUTPUT_BYTES) {
    return metadataOverflowOutput(results.length);
  }

  let extraBytes = MAXIMUM_PARALLEL_OUTPUT_BYTES - minimumBytes;
  const parts: string[] = [];
  for (const [index, result] of normalized.entries()) {
    const minimumPart = minimumParts[index];
    if (minimumPart === undefined) {
      throw new Error("Parallel result metadata was not generated");
    }
    const remainingResults = normalized.length - index;
    const allowance =
      serializedBytes(minimumPart) + Math.floor(extraBytes / remainingResults);
    const part = fitSerializedResult(result, allowance);
    extraBytes -= serializedBytes(part) - serializedBytes(minimumPart);
    parts.push(part);
  }
  return `[${parts.join(",")}]`;
}

function childText(
  recipientName: string,
  field: "error" | "output",
  value: string,
): ParallelCallResult {
  const bounded = truncateParallelText(
    value,
    MAXIMUM_PARALLEL_CHILD_OUTPUT_BYTES,
  );
  return field === "error"
    ? { error: bounded, recipient_name: recipientName }
    : { output: bounded, recipient_name: recipientName };
}

export async function executeParallelCall(
  recipientName: string,
  execute: () => Promise<string>,
  signal?: AbortSignal,
): Promise<ParallelCallResult> {
  try {
    return childText(recipientName, "output", await execute());
  } catch (error) {
    if (signal?.aborted !== true) {
      return parallelCallFailure(recipientName, error);
    }
    return Promise.reject(parallelError(error));
  }
}

export async function executeParallelResultCall(
  recipientName: string,
  execute: () => Promise<RunnerCommandResult>,
  signal?: AbortSignal,
): Promise<ParallelToolResult> {
  let state: RunnerCommandResult["state"] = "completed";
  const canonical = await executeParallelCall(
    recipientName,
    async () => {
      const result = await execute();
      state = result.state;
      return result.output;
    },
    signal,
  );
  return {
    canonical,
    state: "error" in canonical ? "failed" : state,
  };
}

function parallelCallFailure(
  recipientName: string,
  error: unknown,
): ParallelCallResult {
  return childText(recipientName, "error", parallelError(error).message);
}
