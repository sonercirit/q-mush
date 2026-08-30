import { afterEach, expect, test, vi } from "vitest";

import { startRunnerOperationSynchronization } from "../runner/runner-operation-start.ts";
import { createRunnerReadySynchronization } from "../runner/runner-ready-synchronization.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const store = {
  acknowledge: () => undefined,
  apply: () => undefined,
  pending: () => [],
  rejectOutbox: () => undefined,
  state: () => ({ frontier: {} }),
};
const installFetch = (
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) => {
  globalThis.fetch = Object.assign(fetch, {
    preconnect: originalFetch.preconnect,
  });
};
const successfulResponse = (): Promise<Response> =>
  Promise.resolve(Response.json({ envelopes: [], hasMore: false }));
const instantDelay = (): Promise<void> => Promise.resolve();
const midpointRandom = (): number => 0.5;
const recordDelay =
  (delays: number[], stop: () => void, count: number) =>
  (milliseconds: number): Promise<void> => {
    delays.push(milliseconds);
    if (delays.length === count) stop();
    return instantDelay();
  };
const start = (
  options: Parameters<typeof startRunnerOperationSynchronization>[3],
) =>
  startRunnerOperationSynchronization(
    store,
    "http://engine.test",
    "token",
    options,
  );

test("continues after successful iterations at the steady-state schedule", async () => {
  let requests = 0;
  installFetch(() => {
    requests += 1;
    return successfulResponse();
  });
  const controller = start({
    delay: (milliseconds) => {
      expect(milliseconds).toBe(5_000);
      if (requests >= 4) controller.abort();
      return instantDelay();
    },
    random: midpointRandom,
  });
  await vi.waitFor(() => {
    expect(requests).toBeGreaterThanOrEqual(4);
  });
});

test("resets failures to steady-state scheduling after success", async () => {
  let request = 0;
  installFetch(() => {
    request += 1;
    if (request <= 4) return Promise.reject(new Error("offline"));
    return successfulResponse();
  });
  const delays: number[] = [];
  const controller = start({
    delay: recordDelay(
      delays,
      () => {
        controller.abort();
      },
      3,
    ),
    log: () => undefined,
    random: midpointRandom,
  });
  await vi.waitFor(() => {
    expect(delays).toEqual([1_000, 2_000, 5_000]);
  });
});

test("retries engine failures with capped exponential backoff", async () => {
  installFetch(() => Promise.reject(new Error("offline")));
  const delays: number[] = [];
  const finished = Promise.withResolvers<undefined>();
  const controller = start({
    delay: recordDelay(
      delays,
      () => {
        finished.resolve(undefined);
      },
      7,
    ),
    random: midpointRandom,
    log: (message) => {
      expect(message.startsWith("Operation")).toBe(true);
    },
  });
  await finished.promise;
  controller.abort();
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("shutdown aborts an in-flight engine request", async () => {
  const requestStarted = Promise.withResolvers<AbortSignal>();
  installFetch((_input, init) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) throw new Error("Missing signal");
    requestStarted.resolve(signal);
    return Promise.withResolvers<Response>().promise;
  });
  const controller = start({ log: () => undefined });
  const signal = await requestStarted.promise;
  controller.abort();
  expect(signal.aborted).toBe(true);
});

test("starts synchronization only from ready and restarts per lifecycle", () => {
  const events: string[] = [];
  const first = new AbortController();
  const second = new AbortController();
  const begin = vi
    .fn()
    .mockImplementationOnce(() => {
      events.push("sync:first");
      return first;
    })
    .mockImplementationOnce(() => {
      events.push("sync:second");
      return second;
    });
  const lifecycle = createRunnerReadySynchronization({
    origin: "http://engine.test",
    start: begin,
    store,
    token: "token",
  });
  expect(begin).not.toHaveBeenCalled();
  events.push("ready:first");
  lifecycle.ready();
  lifecycle.disconnected();
  expect(first.signal.aborted).toBe(true);
  events.push("ready:second");
  lifecycle.ready();
  expect(events).toEqual([
    "ready:first",
    "sync:first",
    "ready:second",
    "sync:second",
  ]);
  lifecycle.disconnected();
  expect(second.signal.aborted).toBe(true);
});
