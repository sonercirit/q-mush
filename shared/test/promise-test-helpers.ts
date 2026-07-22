export async function captureBrokerRejection(
  promise: Promise<unknown>,
): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
