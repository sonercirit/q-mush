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
  stallOutbox: () => undefined,
  state: () => ({ frontier: {}, outboxStalls: [] }),
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
const waitForDelays = async (
  delays: readonly number[],
  expected: readonly number[],
) => {
  await vi.waitFor(() => {
    expect(delays).toEqual(expected);
  });
};
const abortAt = (
  delays: number[],
  count: number,
  controller: () => AbortController,
) =>
  recordDelay(
    delays,
    () => {
      controller().abort();
    },
    count,
  );
const controllerHolder = () => {
  const holder: { current?: AbortController } = {};
  return {
    assign(controller: AbortController) {
      holder.current = controller;
    },
    get: () => {
      if (holder.current === undefined)
        throw new Error("Synchronization controller unavailable");
      return holder.current;
    },
  };
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
    if (request < 5) return Promise.reject(new Error("offline"));
    return successfulResponse();
  });
  const delays: number[] = [];
  const holder = controllerHolder();
  const controller = start({
    delay: abortAt(delays, 3, holder.get),
    log: () => undefined,
    random: midpointRandom,
  });
  holder.assign(controller);
  await waitForDelays(delays, [1_000, 2_000, 5_000]);
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

test("counts one partition failure as a failed cycle while its peer advances", async () => {
  let cycle = 0;
  installFetch((_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const partition = body.includes('"partition":"non-session"')
      ? "non-session"
      : "session";
    if (partition === "non-session" && cycle === 0) {
      const failure = new Error("partition offline");
      return Promise.reject(failure);
    }
    return successfulResponse().then((response) => response);
  });
  const delays: number[] = [];
  const logs: string[] = [];
  const controller = start({
    delay: (milliseconds) => {
      delays.push(milliseconds);
      cycle += 1;
      if (delays.length === 2) controller.abort();
      return instantDelay();
    },
    log: (message) => logs.push(message),
    random: midpointRandom,
  });
  await waitForDelays(delays, [1_000, 5_000]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("partition offline");
});

test("repeated 403 retains outbox and uses capped failure backoff", async () => {
  const pendingStore = {
    ...store,
    pending: () => ["local"],
  };
  installFetch((_input, init) =>
    init?.method === "POST"
      ? Promise.resolve(new Response(null, { status: 403 }))
      : successfulResponse(),
  );
  const retryDelays: number[] = [];
  const holder = controllerHolder();
  const controller = startRunnerOperationSynchronization(
    pendingStore,
    "http://engine.test",
    "token",
    {
      delay: abortAt(retryDelays, 7, holder.get),
      log: () => undefined,
      random: midpointRandom,
    },
  );
  holder.assign(controller);
  await waitForDelays(
    retryDelays,
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
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
