export function optionalAbortSignal(
  signal: AbortSignal | undefined,
): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
}

export function abortSignalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
