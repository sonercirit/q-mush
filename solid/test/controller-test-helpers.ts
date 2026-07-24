import { createEffect, createRoot } from "solid-js";
import { expect } from "vitest";

interface RealtimeController<Value> {
  applyRealtime(value: Value): void;
  load(): Promise<void>;
}

const ORIGINAL_FETCH = globalThis.fetch;

type FetchImplementation = (
  ...parameters: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export function installTestFetch(implementation: FetchImplementation): void {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: ORIGINAL_FETCH.preconnect,
  });
}

export function restoreTestFetch(): void {
  globalThis.fetch = ORIGINAL_FETCH;
}

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

export async function expectRealtimeToRemainSilent<Value>(
  createController: () => RealtimeController<Value> & {
    readonly view: () => unknown;
  },
  fetchImplementation: FetchImplementation,
  realtimeValue: Value,
): Promise<void> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = Object.assign(fetchImplementation, {
    preconnect: originalFetch.preconnect,
  });

  try {
    await createRoot(async (dispose) => {
      let changes = 0;
      const controller = createController();
      createEffect(() => {
        controller.view();
        changes += 1;
      });

      await controller.load();
      const changesAfterLoad = changes;
      controller.applyRealtime(realtimeValue);

      expect(changes).toBe(changesAfterLoad);
      dispose();
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
