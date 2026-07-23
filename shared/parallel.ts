import { Buffer } from "node:buffer";

const PARALLEL_CALL_CONCURRENCY = 4;
const MAXIMUM_PARALLEL_CHILD_OUTPUT_BYTES = 50 * 1_024;
const MAXIMUM_PARALLEL_OUTPUT_BYTES = 256 * 1_024;
const PARALLEL_TRUNCATION_MARKER = "[parallel output truncated]";

export type ParallelCallResult =
  | { readonly error: string; readonly recipient_name: string }
  | { readonly output: string; readonly recipient_name: string };

interface ParallelExecutor<Input, Output> {
  readonly execute: (item: Input, index: number) => Promise<Output>;
  readonly items: readonly Input[];
  readonly signal: AbortSignal | undefined;
}

interface NormalizedParallelResult {
  readonly field: "error" | "output";
  readonly recipientName: string;
  readonly value: string;
}

function parallelAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was stopped", "AbortError");
}

function ensureParallelActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw parallelAbortError(signal);
}

async function parallelWorker<Input, Output>(
  options: ParallelExecutor<Input, Output>,
  results: ({ readonly value: Output } | undefined)[],
  state: { nextIndex: number },
): Promise<void> {
  for (;;) {
    ensureParallelActive(options.signal);
    const index = state.nextIndex;
    const item = options.items[index];
    if (item === undefined) {
      return;
    }
    state.nextIndex += 1;
    results[index] = { value: await options.execute(item, index) };
  }
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
  const state = { nextIndex: 0 };
  const workers = Array.from(
    { length: Math.min(PARALLEL_CALL_CONCURRENCY, items.length) },
    () => parallelWorker(executor, results, state),
  );
  const settlements = await Promise.allSettled(workers);
  const failure = settlements.find(
    (settlement) => settlement.status === "rejected",
  );
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
  ensureParallelActive(signal);
  return completedParallelResults(results);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }

  let end = Math.max(0, maximumBytes);
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
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
  const complete = JSON.stringify(
    normalized.map((result) => resultValue(result, result.value)),
    null,
    2,
  );
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

export async function executeParallelCall(
  recipientName: string,
  execute: () => Promise<string>,
  signal?: AbortSignal,
): Promise<ParallelCallResult> {
  try {
    return { output: await execute(), recipient_name: recipientName };
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    return parallelCallFailure(recipientName, error);
  }
}

function parallelCallFailure(
  recipientName: string,
  error: unknown,
): ParallelCallResult {
  return {
    error: error instanceof Error ? error.message : String(error),
    recipient_name: recipientName,
  };
}
