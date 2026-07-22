export function observeRunnerRejection(
  promise: Promise<unknown>,
): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

export function requireRunnerError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  throw new Error("Expected the runner operation to fail with an Error");
}
