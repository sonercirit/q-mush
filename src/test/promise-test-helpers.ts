export function requireError(value: unknown): Error {
  if (!(value instanceof Error)) {
    throw new Error("The promise did not reject with an Error");
  }

  return value;
}

export async function captureRejection(
  promise: Promise<unknown>,
): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
