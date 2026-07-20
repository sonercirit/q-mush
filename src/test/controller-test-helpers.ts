import { expect } from "bun:test";

interface RefreshController {
  load(): Promise<void>;
  refresh(): Promise<void>;
}

type FetchImplementation = (
  ...parameters: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export async function expectRefreshToRemainSilent(
  createController: (onChange: () => void) => RefreshController,
  fetchImplementation: FetchImplementation,
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

    await controller.refresh();

    expect(changes).toBe(changesAfterLoad);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
