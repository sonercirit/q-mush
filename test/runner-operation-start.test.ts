import { afterEach, expect, test } from "vitest";

import { startRunnerOperationSynchronization } from "../runner/runner-operation-start.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const store = {
  acknowledge: () => undefined,
  apply: () => undefined,
  pending: () => [],
  state: () => ({ frontier: {} }),
};

test("retries engine failures with capped exponential backoff", async () => {
  const offline = () => Promise.reject(new Error("offline"));
  offline.preconnect = originalFetch.preconnect;
  globalThis.fetch = offline;
  const delays: number[] = [];
  const finished = Promise.withResolvers<undefined>();
  const controller = startRunnerOperationSynchronization(
    store,
    new URL("/api", "http://engine.test").origin,
    "retry-token",
    {
      delay: (milliseconds) => {
        delays.push(milliseconds);
        const cappedTwice = delays.filter((item) => item === 30_000).length > 1;
        if (cappedTwice) finished.resolve(undefined);
        return Promise.resolve();
      },
      log: (message) => {
        expect(message.startsWith("Operation")).toBe(true);
      },
    },
  );
  await finished.promise;
  controller.abort();
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("shutdown aborts an in-flight engine request", async () => {
  const requestStarted = Promise.withResolvers<AbortSignal>();
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("Missing signal");
      requestStarted.resolve(signal);
      return Promise.withResolvers<Response>().promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  const controller = startRunnerOperationSynchronization(
    store,
    new URL("http://engine.test").origin,
    "token",
    {
      log: (message) => {
        expect(message).toBeTypeOf("string");
      },
    },
  );
  const signal = await requestStarted.promise;
  controller.abort();
  expect(signal.aborted).toBe(true);
});
