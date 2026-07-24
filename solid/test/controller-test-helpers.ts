import { createEffect, createRoot } from "solid-js";
import { expect } from "vitest";

interface RealtimeController<Value> {
  applyRealtime(value: Value): void;
  load(): Promise<void>;
}

export interface ReactiveController {
  readonly view: () => unknown;
}

export function countReactiveChanges(controller: ReactiveController): {
  readonly count: () => number;
} {
  let changes = 0;
  createEffect(() => {
    controller.view();
    changes += 1;
  });
  return { count: () => changes };
}

type FetchImplementation = (
  ...parameters: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export function installFetch(implementation: FetchImplementation): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export async function withRestoredFetch(
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
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
      const controller = createController();
      const changes = countReactiveChanges(controller);

      await controller.load();
      const changesAfterLoad = changes.count();
      controller.applyRealtime(realtimeValue);

      expect(changes.count()).toBe(changesAfterLoad);
      dispose();
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
