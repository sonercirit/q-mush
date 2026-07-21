import { expect } from "bun:test";

interface RealtimeController<Value> {
  applyRealtime(value: Value): void;
  load(): Promise<void>;
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

export async function expectRealtimeToRemainSilent<Value>(
  createController: (onChange: () => void) => RealtimeController<Value>,
  fetchImplementation: FetchImplementation,
  realtimeValue: Value,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let changes = 0;

  globalThis.fetch = Object.assign(fetchImplementation, {
    preconnect: originalFetch.preconnect,
  });

  try {
    const controller = createController(() => {
      changes += 1;
    });

    await controller.load();
    const changesAfterLoad = changes;

    controller.applyRealtime(realtimeValue);

    expect(changes).toBe(changesAfterLoad);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
