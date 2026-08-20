export function abortSignalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
