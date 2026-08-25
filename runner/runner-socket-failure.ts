import { setTimeout } from "node:timers/promises";

export async function pendingSocketFailure(
  failure: Promise<Error>,
  milliseconds: number,
): Promise<Error | undefined> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      setTimeout(milliseconds, undefined, { signal: controller.signal }).catch(
        (error: unknown) => {
          if (!controller.signal.aborted) throw error;
          return undefined;
        },
      ),
      failure,
    ]);
  } finally {
    controller.abort();
  }
}
