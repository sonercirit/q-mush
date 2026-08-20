import type { AbortableOperationOptions } from "../shared/validation.ts";

type ResponseReader = ReadableStreamDefaultReader<Uint8Array>;

export interface CancelableResponseReader {
  readonly cancel: () => Promise<void>;
  readonly options: (abortMessage: string) => AbortableOperationOptions;
  readonly release: (signal: AbortSignal) => void;
}

export function cancelableResponseReader(
  reader: ResponseReader,
): CancelableResponseReader {
  let cancellation: Promise<void> | undefined;
  const cancel = (): Promise<void> =>
    (cancellation ??= reader.cancel().catch(() => undefined));
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative cancellation may keep the stream locked; abort
      // settlement must not wait for it or turn cleanup into a new failure.
    }
  };
  return {
    cancel,
    options: (abortMessage) => ({ abortMessage, onAbort: cancel }),
    release: (signal) => {
      if (!signal.aborted) {
        release();
        return;
      }
      release();
      void cancel();
    },
  };
}
