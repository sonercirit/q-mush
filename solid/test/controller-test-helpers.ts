import { createEffect, createRoot } from "solid-js";
import { afterEach, expect } from "vitest";

interface RealtimeController<Value> {
  applyRealtime(value: Value): void;
  load(): Promise<void>;
}

type FetchImplementation = (
  ...parameters: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

export async function withRestoredFetch(
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    await action();
  } finally {
    restoreFetch(originalFetch);
  }
}

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

export function installFetch(
  implementation: FetchImplementation,
): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
  return originalFetch;
}

function restoreFetch(originalFetch: typeof globalThis.fetch): void {
  globalThis.fetch = originalFetch;
}

export interface RecordedRequest {
  body: unknown;
  method: string;
  url: string;
}

function recordedRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RecordedRequest {
  return {
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    method: init?.method ?? "GET",
    url: requestUrl(input),
  };
}

function originalFetchRestorer(): () => void {
  const originalFetch = globalThis.fetch;
  return () => {
    restoreFetch(originalFetch);
  };
}

export function restoreFetchAfterEach(): void {
  afterEach(originalFetchRestorer());
}

export function installRecordedRequestFetch(
  requests: RecordedRequest[],
  response: (request: RecordedRequest, init?: RequestInit) => Response,
): void {
  installFetch((input, init) => {
    const request = recordedRequest(input, init);
    requests.push(request);
    return Promise.resolve(response(request, init));
  });
}

export function installRecordedFetch(
  requests: RecordedRequest[],
  response: (init?: RequestInit) => Response,
): void {
  installRecordedRequestFetch(requests, (_request, init) => response(init));
}

export async function expectRealtimeToRemainSilent<Value>(
  createController: () => RealtimeController<Value> & {
    readonly view: () => unknown;
  },
  fetchImplementation: FetchImplementation,
  realtimeValue: Value,
): Promise<void> {
  const originalFetch = installFetch(fetchImplementation);

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
    restoreFetch(originalFetch);
  }
}
