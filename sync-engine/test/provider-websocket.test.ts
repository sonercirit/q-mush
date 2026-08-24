import { expect, test } from "vitest";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { ProviderWebSocketSession } from "../../sync-engine/provider-websocket.ts";
import { captureRejection } from "./promise-test-helpers.ts";
import {
  acknowledgeProviderSocket,
  apiKeyModel,
  chatCompletedResponse,
  complete,
  COMPLETED_EVENT,
  expectBoundedHttpFallback,
  expectProviderSocketReleased,
  expireProviderSocket,
  FakeProviderSocket,
  FakeProviderSockets,
  providerDelta,
  recordDelay,
  replaceProviderSocket,
  requireProviderSocket,
  retryingSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";
import {
  beginLifecycleRequest,
  completeResponse,
  completeWithSignal,
  createInstrumentedAbortController,
  expectAbortWithoutHttp,
  expectRequestPending,
  expectRequestStates,
  instrumentedProviderRequest,
  lifecycleModel,
  responseEvent,
} from "./provider-websocket-lifecycle-fixtures.ts";

test("prefers Responses WebSocket for API keys", async () => {
  const sockets: FakeProviderSocket[] = [];
  const model = apiKeyModel({
    webSocket: (url, options) => {
      expect(url).toBe("wss://api.openai.com/v1/responses");
      expect(options.headers["authorization"]).toBe("Bearer sk-openai");
      const socket = new FakeProviderSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const pending = complete(model);
  const socket = sockets[0];
  expect(socket).toBeDefined();
  socket?.open();
  expect(JSON.parse(socket?.sent[0] ?? "{}")).toMatchObject({
    input: [{ role: "user", type: "message" }],
    model: "api-test-model",
    store: false,
    type: "response.create",
  });
  expect(JSON.parse(socket?.sent[0] ?? "{}")).not.toHaveProperty("stream");
  socket?.receive(responseEvent("response.created", "response-complete"));
  socket?.receive({ type: "response.output_text.delta", delta: "Done." });
  socket?.receive(COMPLETED_EVENT);
  expectDoneStep(await pending);
});

test("accepts terminal-only responses on a fresh socket", async () => {
  const sockets = new FakeProviderSockets();
  const pending = complete(apiKeyModel({ webSocket: sockets.create }));
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  completeResponse(socket, "terminal-only");
  expectDoneStep(await pending);
  socket.close();
});

test("bounds admission through unknown frames", async () => {
  const observedStates: ("active" | "admission")[] = [];
  const request = beginLifecycleRequest(observedStates);
  request.socket.receive({ type: "provider.keepalive" });
  expectRequestStates(observedStates, "admission");
  await expectRequestPending(request.pending);
  request.socket.receive(responseEvent("response.created", "current"));
  request.socket.receive({
    delta: "Done.",
    item_id: "message-current",
    output_index: 0,
    type: "response.output_text.delta",
  });
  expectRequestStates(observedStates, "admission", "active");
  request.socket.receive({
    response: { id: "stale", output: [{ content: "Wrong" }] },
    type: "response.completed",
  });
  await expectRequestPending(request.pending);
  completeResponse(request.socket, "current");
  expectDoneStep(await request.pending);
});

test("removes abort listener after success", async () => {
  const { controller, pending, socket } = instrumentedProviderRequest();
  expect(controller.abortListenerCount).toBe(1);
  acknowledgeProviderSocket(socket);
  socket.receive(COMPLETED_EVENT);
  await pending;
  expect(controller.abortListenerCount).toBe(0);
});

test("removes abort listener after abort", async () => {
  const { controller, pending, socket } = instrumentedProviderRequest();
  controller.abort();
  const error = await captureRejection(pending);
  expect(error).toBeInstanceOf(DOMException);
  expect(error instanceof DOMException ? error.name : "").toBe("AbortError");
  expect(controller.abortListenerCount).toBe(0);
  expectProviderSocketReleased(socket);
});

test("cleans up when send throws", async () => {
  const controller = createInstrumentedAbortController();
  const socket = new FakeProviderSocket();
  socket.throwOnSend = true;
  const model = apiKeyModel({ webSocket: () => socket });
  const pending = completeWithSignal(model, controller.signal);
  socket.open();
  await expect(pending).rejects.toThrow("send failed");
  expectProviderSocketReleased(socket);
  expect(socket.listenerCount("open")).toBe(0);
  expect(controller.abortListenerCount).toBe(0);
});

test("correlates deltas on a reused socket", async () => {
  const states: ("active" | "admission")[] = [];
  const request = beginLifecycleRequest(states);
  const { model, pending: first, socket } = request;
  acknowledgeProviderSocket(socket, "response-1");
  expectRequestStates(states, "admission", "active");
  completeResponse(socket, "response-1");
  await first;
  const controller = new AbortController();
  const stalled = model.complete(
    [{ content: "Continue", role: "user" }],
    controller.signal,
  );
  expect(socket.sent).toHaveLength(2);
  const waitingStates = ["admission", "active", "admission"] as const;
  expectRequestStates(states, ...waitingStates);
  expect(socket.listenerCount("message")).toBe(1);
  socket.receive(responseEvent("response.created", "response-1"));
  socket.receive({
    delta: "Stale",
    response_id: "response-1",
    type: "response.output_text.delta",
  });
  expectRequestStates(states, ...waitingStates);
  await expectRequestPending(stalled);
  socket.receive({
    delta: "Done.",
    response_id: "response-2",
    type: "response.output_text.delta",
  });
  expectRequestStates(states, ...waitingStates, "active");
  socket.receive({
    delta: " stale",
    response_id: "response-1",
    type: "response.output_text.delta",
  });
  completeResponse(socket, "response-2");
  expectDoneStep(await stalled);
  socket.close();
  expectProviderSocketReleased(socket);
});

test.each([
  ["fresh-first", true],
  ["reused-first", false],
])(
  "keeps a defensive-copy fence while the newest socket wins a %s concurrent reset",
  async (_order, freshFirst) => {
    const observed: ("active" | "admission")[] = [];
    const lifecycle = lifecycleModel(observed);
    const { model, sockets } = lifecycle;
    const first = complete(model);
    const old = requireProviderSocket(sockets, 0);
    old.open();
    acknowledgeProviderSocket(old, "old");
    completeResponse(old, "old");
    await first;
    for (let generation = 0; generation < 40; generation += 1) {
      const id = String(generation);
      const pending = complete(model);
      acknowledgeProviderSocket(old, id);
      completeResponse(old, id);
      await pending;
    }
    const reused = complete(model);
    const fresh = complete(model);
    const next = requireProviderSocket(sockets, 1);
    next.open();
    old.receive({
      delta: "Stale",
      response_id: "old",
      type: "response.output_text.delta",
    });
    acknowledgeProviderSocket(old, "current");
    acknowledgeProviderSocket(next, "fresh");
    if (freshFirst) {
      completeResponse(next, "fresh");
      expectDoneStep(await fresh);
      completeResponse(old, "current");
      expectDoneStep(await reused);
    } else {
      completeResponse(old, "current");
      expectDoneStep(await reused);
      completeResponse(next, "fresh");
      expectDoneStep(await fresh);
    }
    expect(old.readyState).toBe(WebSocket.CLOSED);
    expectProviderSocketReleased(old);
    const subsequent = complete(model);
    expect(next.sent).toHaveLength(2);
    acknowledgeProviderSocket(next, "subsequent");
    completeResponse(next, "subsequent");
    expectDoneStep(await subsequent);
    next.close();
  },
);

test("retires rather than evicts a socket whose response-ID fence exceeds one frame", async () => {
  const sockets = new FakeProviderSockets();
  const session = new ProviderWebSocketSession();
  const completeSession = () =>
    session.complete({
      body: {},
      createSocket: sockets.create,
      headers: {},
      url: "wss://provider.test/responses",
    });
  const first = completeSession();
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  const oversizedId = "x".repeat(16 * 1024 * 1024 + 1);
  acknowledgeProviderSocket(socket, oversizedId);
  completeResponse(socket, oversizedId);
  expectDoneStep(await first);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(socket.closeReason).toBe("Response ID retention limit reached");

  const second = completeSession();
  const replacement = requireProviderSocket(sockets, 1);
  replacement.open();
  socket.receive(responseEvent("response.created", "big"));
  socket.receive({
    delta: "Late stale output",
    response_id: "big",
    type: "response.output_text.delta",
  });
  await expectRequestPending(second);
  acknowledgeProviderSocket(replacement, "big");
  completeResponse(replacement, "big");
  expectDoneStep(await second);
  replacement.close();
});

test("retires a socket after an unidentified response", async () => {
  const request = beginLifecycleRequest([]);
  request.socket.receive({ response: {}, type: "response.created" });
  request.socket.receive(COMPLETED_EVENT);
  expectDoneStep(await request.pending);
  expect(request.socket.readyState).toBe(WebSocket.CLOSED);
  expect(request.socket.closeReason).toBe("Unidentified response complete");
  expectProviderSocketReleased(request.socket);

  const next = complete(request.model);
  expect(request.sockets.created).toHaveLength(2);
  const replacement = requireProviderSocket(request.sockets, 1);
  replacement.open();
  acknowledgeProviderSocket(replacement, "identified");
  completeResponse(replacement, "identified");
  expectDoneStep(await next);
  replacement.close();
});

test("reuses a socket and reconnects after idle close", async () => {
  const stepSockets = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: stepSockets.create });
  const first = complete(model);
  await stepSockets.waitForAttempt(0);
  const socket = stepSockets.created[0];
  socket?.open();
  if (socket !== undefined) acknowledgeProviderSocket(socket, "first");
  socket?.receive(responseEvent("response.completed", "first"));
  expectDoneStep(await first);
  const second = complete(model);
  expect(socket?.sent).toHaveLength(2);
  if (socket !== undefined) acknowledgeProviderSocket(socket, "second");
  socket?.receive(responseEvent("response.completed", "second"));
  expectDoneStep(await second);
  expect(stepSockets.created).toHaveLength(1);
  socket?.close();
  const third = complete(model);
  await stepSockets.waitForAttempt(1);
  const reconnected = stepSockets.created[1];
  reconnected?.open();
  if (reconnected !== undefined) acknowledgeProviderSocket(reconnected);
  reconnected?.receive(COMPLETED_EVENT);
  expectDoneStep(await third);
  model.close();
  expect(reconnected?.readyState).toBe(WebSocket.CLOSED);
});

test("does not start an HTTP fallback after a WebSocket abort", async () => {
  const controller = new AbortController();
  let socket: FakeProviderSocket | undefined;
  const model = apiKeyModel({
    webSocket: () => {
      socket = new FakeProviderSocket();
      return socket;
    },
  });
  await expectAbortWithoutHttp(model, controller, () => {
    socket?.open();
    controller.abort();
  });
});

test("aborts immediately during WebSocket retry backoff", async () => {
  const controller = new AbortController();
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({
    sleep: (_milliseconds, signal) => {
      if (signal !== controller.signal) {
        throw new Error("The retry used the wrong abort signal");
      }
      const abort = new DOMException("Stopped", "AbortError");
      controller.abort(abort);
      return Promise.reject(abort);
    },
    webSocket: sockets.create,
  });
  await expectAbortWithoutHttp(model, controller, () => {
    sockets.created[0]?.close();
  });
});
test.each([
  "websocket_connection_limit_reached",
  "websocketconnectionlimit_reached",
])(
  "reconnects immediately when the provider expires the socket (%s)",
  async (code) => {
    const { delays, deltas, pending, sockets } = retryingSocket();
    const expired = requireProviderSocket(sockets, 0);
    expired.open();
    acknowledgeProviderSocket(expired);
    expired.receive({
      delta: "Partial",
      type: "response.output_text.delta",
    });
    expireProviderSocket(expired, code);
    await replaceProviderSocket(sockets);
    const replacement = requireProviderSocket(sockets, 1);
    expectDoneStep(await pending);
    expect(expired.readyState).toBe(WebSocket.CLOSED);
    expect([expired.closeCode, expired.closeReason]).toEqual([
      1011,
      "Provider request failed",
    ]);
    expect(replacement.sent).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(deltas).toEqual([providerDelta("Partial"), providerDelta("", true)]);
  },
);

interface ExpiryAttemptsOptions {
  readonly count: number;
  readonly retryAfterSeconds?: number;
  readonly sockets: FakeProviderSockets;
}

async function expireAttempts(options: ExpiryAttemptsOptions): Promise<void> {
  for (let attempt = 0; attempt < options.count; attempt += 1) {
    await options.sockets.waitForAttempt(attempt);
    const expired = requireProviderSocket(options.sockets, attempt);
    expired.open();
    expireProviderSocket(
      expired,
      "websocket_connection_limit_reached",
      options.retryAfterSeconds,
    );
  }
}

async function recoverAfterExpiries(
  options: ExpiryAttemptsOptions,
): Promise<void> {
  await expireAttempts(options);
  await replaceProviderSocket(options.sockets, options.count);
}

async function expectRecoveredSocket(options: {
  readonly delays: number[];
  readonly pending: ReturnType<typeof complete>;
  readonly sockets: FakeProviderSockets;
}): Promise<void> {
  expectDoneStep(await options.pending);
  expect(options.delays).toEqual([1_000]);
  expect(options.sockets.created).toHaveLength(3);
}
test("reconnects immediately after a transient failure then socket expiry", async () => {
  const { delays, pending, sockets } = retryingSocket();
  const transient = requireProviderSocket(sockets, 0);
  transient.fail();
  await sockets.waitForAttempt(1);
  const expired = requireProviderSocket(sockets, 1);
  expired.open();
  expireProviderSocket(expired, "websocket_connection_limit_reached");
  await replaceProviderSocket(sockets, 2);
  await expectRecoveredSocket({ delays, pending, sockets });
  expect(expired.closeCode).toBe(1011);
});

test("ignores retry-after when a repeated socket expiry uses bounded backoff", async () => {
  const { delays, pending, sockets } = retryingSocket();
  await recoverAfterExpiries({ count: 2, retryAfterSeconds: 60, sockets });
  await expectRecoveredSocket({ delays, pending, sockets });
});

test("keeps ordinary retry capacity after an immediate expiry reconnect", async () => {
  const retry = retryingSocket();
  const { delays, pending } = retry;
  const expired = requireProviderSocket(retry.sockets, 0);
  expired.open();
  expireProviderSocket(expired, "websocket_connection_limit_reached");
  await retry.sockets.waitForAttempt(1);
  const secondSocket = requireProviderSocket(retry.sockets, 1);
  secondSocket.fail();
  await replaceProviderSocket(retry.sockets, 2);
  expectDoneStep(await pending);
  expect(delays).toEqual([1_000]);
});

test("bounds repeated connection-limit reconnects", async () => {
  const setup: { delays: number[]; sockets: FakeProviderSockets } = {
    delays: [],
    sockets: new FakeProviderSockets(),
  };
  const model = apiKeyModel({
    fetch: () => Promise.resolve(chatCompletedResponse()),
    sleep: recordDelay(setup.delays),
    webSocket: setup.sockets.create,
  });
  const pending = complete(model);
  await expireAttempts({ count: 5, sockets: setup.sockets });
  expect(setup.delays).toEqual([1_000, 2_000, 4_000]);
  expect(setup.sockets.created).toHaveLength(5);
  expect((await pending).content).toBe("Done.");
});

test("retries partial output after a socket error without stale deltas", async () => {
  const { delays, deltas, pending, sockets } = retryingSocket();
  const partialSocket = sockets.created[0];
  partialSocket?.open();
  if (partialSocket !== undefined) acknowledgeProviderSocket(partialSocket);
  partialSocket?.receive({
    delta: "Partial",
    type: "response.output_text.delta",
  });
  partialSocket?.fail();
  await sockets.waitForAttempt(1);
  expect(partialSocket?.readyState).toBe(WebSocket.CLOSED);
  partialSocket?.receive({
    delta: " stale",
    type: "response.output_text.delta",
  });
  const recoveredSocket = sockets.created[1];
  recoveredSocket?.open();
  if (recoveredSocket !== undefined) acknowledgeProviderSocket(recoveredSocket);
  recoveredSocket?.receive({
    delta: "Done.",
    type: "response.output_text.delta",
  });
  recoveredSocket?.receive(COMPLETED_EVENT);
  expectDoneStep(await pending);
  const expectedDeltas: ProviderTextDelta[] = [
    providerDelta("Partial"),
    providerDelta("", true),
    providerDelta("Done."),
  ];
  expect(deltas).toStrictEqual(expectedDeltas);
  expect(delays).toEqual([1_000]);
});

test("retries transient failures and clears partial output", async () => {
  const retry = retryingSocket();
  const { delays, deltas, pending, sockets } = retry;
  const failedSocket = sockets.created[0];
  failedSocket?.open();
  if (failedSocket !== undefined)
    acknowledgeProviderSocket(failedSocket, "response-transient");
  failedSocket?.receive({
    delta: "Partial",
    type: "response.output_text.delta",
  });
  failedSocket?.receive({
    error: {
      code: "upstream_error",
      message: "Temporary upstream failure",
      type: "server_error",
    },
    response: { error: null, id: "response-transient", status: "failed" },
    type: "response.failed",
  });
  await replaceProviderSocket(sockets);
  expectDoneStep(await pending);
  expect({ delays, deltas }).toStrictEqual({
    delays: [1_000],
    deltas: [providerDelta("Partial"), providerDelta("", true)],
  });
});

test("passes through permanent failures", async () => {
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({
    sleep: () => {
      throw new Error("A permanent error must not be delayed");
    },
    webSocket: sockets.create,
  });
  const pending = complete(model);
  sockets.created[0]?.open();
  if (sockets.created[0] !== undefined)
    acknowledgeProviderSocket(sockets.created[0], "response-permanent");
  sockets.created[0]?.receive({
    response: {
      error: {
        code: "context_length_exceeded",
        message: "The prompt exceeds the context limit.",
      },
      id: "response-permanent",
    },
    type: "response.failed",
  });
  const error = await captureRejection(pending);
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toContain(
    "context_length_exceeded",
  );
  expect(sockets.created).toHaveLength(1);
});

test("falls back after bounded transient failures", () =>
  expectBoundedHttpFallback({
    failAttempt: (socket, index) => {
      socket.open();
      acknowledgeProviderSocket(socket, `response-${String(index)}`);
      socket.receive({
        response: {
          error: { code: "server_is_overloaded", message: "Try again later" },
          id: `response-${String(index)}`,
        },
        type: "response.failed",
      });
    },
  }));
test("falls back to HTTP after bounded connection failures", () =>
  expectBoundedHttpFallback({
    failAttempt: (socket) => {
      socket.close();
    },
  }));
