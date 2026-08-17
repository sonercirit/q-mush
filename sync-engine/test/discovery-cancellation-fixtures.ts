import { expect } from "vitest";

export interface StalledResponseReaderFixture {
  readonly cancellation: PromiseWithResolvers<undefined>;
  readonly events: string[];
  readonly reader: {
    readonly cancel: () => Promise<void>;
    readonly read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
    readonly releaseLock: () => void;
  };
  readonly response: Response;
  start<Value>(
    execute: (response: Response, signal: AbortSignal) => Promise<Value>,
  ): {
    readonly captured: Promise<unknown>;
    readonly controller: AbortController;
  };
}

function responseWithReader(
  reader: StalledResponseReaderFixture["reader"],
): Response {
  const response = new Response("{}");
  Object.defineProperty(response, "body", {
    value: { getReader: () => reader },
  });
  return response;
}

export function neverReadingResponse(): Response {
  return responseWithReader({
    cancel: () => Promise.resolve(),
    read: () => new Promise(() => undefined),
    releaseLock: () => undefined,
  });
}

export function stalledResponseReaderFixture(): StalledResponseReaderFixture {
  const cancellation = Promise.withResolvers<undefined>();
  const events = ["fixture-created"];
  const stalledRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
    () => undefined,
  );
  const reader = {
    cancel: async () => {
      events.push("cancel-start");
      await cancellation.promise;
      events.push("cancel-end");
    },
    read: () => stalledRead,
    releaseLock: () => {
      events.push("release");
    },
  };
  const response = responseWithReader(reader);
  return {
    cancellation,
    events,
    reader,
    response,
    start: (execute) => {
      const controller = new AbortController();
      const captured = execute(response, controller.signal).catch(
        (error: unknown) => error,
      );
      return { captured, controller };
    },
  };
}

export async function abortAndObserveCanceledReader(
  fixture: StalledResponseReaderFixture,
  captured: Promise<unknown>,
  controller: AbortController,
): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  const reason = new DOMException(
    "The response reader deadline elapsed",
    "AbortError",
  );
  controller.abort(reason);
  const settled = await captured;
  expect(settled).toBe(reason);
  await expect.poll(() => fixture.events).toContain("cancel-start");
  // Cancellation cleanup is best effort and must not delay abort settlement.
  fixture.cancellation.resolve(undefined);
  await expect.poll(() => fixture.events).toContain("cancel-end");
}
