import { setTimeout } from "node:timers/promises";
import { abortSignalError } from "../shared/validation.ts";

const MAXIMUM_BROWSER_DIAGNOSTIC_BYTES = 4_096;
const CHROMIUM_RETRY_DELAY_MILLISECONDS = 500;

class ChromiumStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromiumStartupError";
  }
}

type ChromiumRetryWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

function exitDescription(child: Bun.ReadableSubprocess): string {
  return `exit code ${String(child.exitCode ?? "null")}, signal ${child.signalCode ?? "none"}`;
}

function boundedUtf8Tail(value: string): string {
  const characters: string[] = [];
  let byteLength = 0;
  for (const character of Array.from(value.trim()).reverse()) {
    const characterByteLength = Buffer.byteLength(character, "utf8");
    if (byteLength + characterByteLength > MAXIMUM_BROWSER_DIAGNOSTIC_BYTES) {
      break;
    }
    characters.push(character);
    byteLength += characterByteLength;
  }
  return characters.reverse().join("");
}

function decodeDiagnostic(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.byteLength) {
    const byte = bytes[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return Buffer.from(bytes.subarray(start)).toString("utf8");
}

function appendDiagnostic(
  diagnostic: Uint8Array,
  part: Uint8Array,
): Uint8Array {
  const combined = Buffer.concat([diagnostic, part]);
  return combined.subarray(
    Math.max(0, combined.byteLength - MAXIMUM_BROWSER_DIAGNOSTIC_BYTES),
  );
}

function startupError(
  child: Bun.ReadableSubprocess,
  diagnostic: Uint8Array,
): ChromiumStartupError {
  const detail = boundedUtf8Tail(decodeDiagnostic(diagnostic));
  return new ChromiumStartupError(
    `Chromium stopped before exposing DevTools (${exitDescription(child)}). Stderr tail: ${detail.length === 0 ? "<empty>" : detail}`,
  );
}

export async function waitForChromiumDevtoolsUrl(
  child: Bun.ReadableSubprocess,
  signal: AbortSignal,
): Promise<string> {
  const reader = child.stderr.getReader();
  let diagnostic: Uint8Array = Buffer.alloc(0);
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      if (signal.aborted) {
        throw abortSignalError(signal, "The page fetch was stopped");
      }
      const part = await reader.read();
      if (part.done) {
        await child.exited;
        throw startupError(child, diagnostic);
      }
      diagnostic = appendDiagnostic(diagnostic, part.value);
      const url = /DevTools listening on (ws:\/\/\S+)/u.exec(
        decodeDiagnostic(diagnostic),
      )?.[1];
      if (url !== undefined) {
        return url;
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => undefined);
  }
}

function attachCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): void {
  if (!(primaryError instanceof Error)) {
    return;
  }
  try {
    primaryError.cause =
      primaryError.cause === undefined
        ? cleanupError
        : new AggregateError(
            [primaryError.cause, cleanupError],
            "Operation and cleanup both failed",
          );
  } catch {
    // A non-extensible primary error must still remain authoritative.
  }
}

export async function runWithCleanup<Value>(
  operation: () => Promise<Value>,
  cleanup: () => Promise<void>,
): Promise<Value> {
  let result: Value;
  try {
    result = await operation();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
  await cleanup();
  return result;
}

async function waitForChromiumRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await setTimeout(milliseconds, undefined, { signal });
}

export async function retryChromiumStartup<Value>(
  operation: () => Promise<Value>,
  signal: AbortSignal,
  wait: ChromiumRetryWait = waitForChromiumRetry,
): Promise<Value> {
  let firstFailure: ChromiumStartupError;
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ChromiumStartupError)) {
      throw error;
    }
    firstFailure = error;
  }
  await wait(CHROMIUM_RETRY_DELAY_MILLISECONDS, signal);
  try {
    return await operation();
  } catch (error) {
    const secondFailure =
      error instanceof Error ? error : new Error(String(error));
    throw new AggregateError(
      [firstFailure, secondFailure],
      `Chromium failed to start after two attempts. Attempt 1: ${firstFailure.message} Attempt 2: ${secondFailure.message}`,
      { cause: error },
    );
  }
}
