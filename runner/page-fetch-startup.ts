import { setTimeout } from "node:timers/promises";

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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The page fetch was stopped");
}

function exitDescription(child: Bun.ReadableSubprocess): string {
  return `exit code ${String(child.exitCode ?? "null")}, signal ${child.signalCode ?? "none"}`;
}

function startupError(
  child: Bun.ReadableSubprocess,
  diagnostic: string,
): ChromiumStartupError {
  const detail = diagnostic.trim().slice(-MAXIMUM_BROWSER_DIAGNOSTIC_BYTES);
  return new ChromiumStartupError(
    `Chromium stopped before exposing DevTools (${exitDescription(child)}). Stderr tail: ${detail.length === 0 ? "<empty>" : detail}`,
  );
}

export async function waitForChromiumDevtoolsUrl(
  child: Bun.ReadableSubprocess,
  signal: AbortSignal,
): Promise<string> {
  const reader = child.stderr.getReader();
  let diagnostic = "";
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      if (signal.aborted) {
        throw abortError(signal);
      }
      const part = await reader.read();
      if (part.done) {
        await child.exited;
        throw startupError(child, diagnostic);
      }
      diagnostic =
        `${diagnostic}${Buffer.from(part.value).toString("utf8")}`.slice(
          -MAXIMUM_BROWSER_DIAGNOSTIC_BYTES,
        );
      const url = /DevTools listening on (ws:\/\/\S+)/u.exec(diagnostic)?.[1];
      if (url !== undefined) {
        return url;
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => undefined);
  }
}

function waitForChromiumRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return setTimeout(milliseconds, undefined, { signal });
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
