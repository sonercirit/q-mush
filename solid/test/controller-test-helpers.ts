import { createEffect, createRoot } from "solid-js";
import { expect } from "vitest";

export interface SilentRealtimeController<Value> {
  applyRealtime(value: Value): void;
  load(): Promise<void>;
  readonly view: () => unknown;
}

type FetchImplementation = (
  ...parameters: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

export async function expectRealtimeControllerToRemainSilent<Value>(
  createController: () => SilentRealtimeController<Value>,
  realtimeValue: Value,
): Promise<void> {
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
}

export async function expectRealtimeToRemainSilent<Value>(
  createController: () => SilentRealtimeController<Value>,
  fetchImplementation: FetchImplementation,
  realtimeValue: Value,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(fetchImplementation, {
    preconnect: originalFetch.preconnect,
  });
  try {
    await expectRealtimeControllerToRemainSilent(
      createController,
      realtimeValue,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
