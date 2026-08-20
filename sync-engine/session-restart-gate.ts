import { abortSignalIsAborted } from "../shared/abort-signal.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import { createApiError } from "./http.ts";

export type RestartSignalReader = () => AbortSignal;

export interface CapturedRestartSignal {
  readonly read: RestartSignalReader;
  readonly signal: AbortSignal;
}

/** Captures the signal identity once at an operation boundary. */
export function captureRestartSignal(
  readSignal: RestartSignalReader,
): CapturedRestartSignal {
  const signal = readSignal();
  return { read: () => signal, signal };
}

export function restartSignalIsAborted(
  readSignal: RestartSignalReader,
): boolean {
  return abortSignalIsAborted(readSignal());
}

export function serverRestartingResponse(): Response {
  return createApiError("server_restarting", 503);
}

export function abortedServerRestartResponse(
  signal: AbortSignal | undefined,
): Response | undefined {
  return abortSignalIsAborted(signal) ? serverRestartingResponse() : undefined;
}

export function throwIfServerRestarting(signal: AbortSignal | undefined): void {
  if (abortSignalIsAborted(signal)) {
    throw new RealtimeCommandError("server_restarting");
  }
}

function translateRestartError(
  signal: AbortSignal | undefined,
  error: unknown,
): never {
  throwIfServerRestarting(signal);
  throw error;
}

export async function withRestartErrorTranslation<T>(
  readSignal: RestartSignalReader,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = readSignal();
  throwIfServerRestarting(signal);
  try {
    const result = await operation(signal);
    throwIfServerRestarting(signal);
    return result;
  } catch (error) {
    return translateRestartError(signal, error);
  }
}
