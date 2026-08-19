import { expect, test } from "vitest";
import type { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
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

class InstrumentedAbortController extends AbortController {
  abortListenerCount = 0;

  constructor() {
    super();
    const signal = this.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      if (type === "abort") this.abortListenerCount += 1;
      add(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions | boolean,
    ) => {
      if (type === "abort") this.abortListenerCount -= 1;
      remove(type, listener, options);
    };
  }
}

function completeWithSignal(
  model: ChatCompletionsAgentModel,
  signal: AbortSignal,
) {
  return model.complete([{ content: "Hello", role: "user" }], signal);
}

function instrumentedProviderRequest() {
  const controller = new InstrumentedAbortController();
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: sockets.create });
  const pending = completeWithSignal(model, controller.signal);
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  return { controller, pending, socket };
}

function lifecycleModel(states: ("active" | "admission")[]) {
  const sockets = new FakeProviderSockets();
  return {
    model: apiKeyModel({
      onRequestState: (state) => states.push(state),
      webSocket: sockets.create,
    }),
    sockets,
  };
}

function beginLifecycleRequest(states: ("active" | "admission")[]) {
  const { model, sockets } = lifecycleModel(states);
  const pending = complete(model);
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  expectRequestStates(states, "admission");
  return { model, pending, socket };
}

function responseEvent(
  type: "response.completed" | "response.created",
  id: string,
) {
  return {
    response:
      type === "response.created"
        ? { id }
        : { ...COMPLETED_EVENT.response, id },
    type,
  };
}

async function expectRequestPending(pending: Promise<unknown>): Promise<void> {
  let settled = false;
  const observeSettlement = (): void => {
    settled = true;
  };
  void pending.then(observeSettlement, observeSettlement);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
}

function expectRequestStates(
  states: readonly ("active" | "admission")[],
  ...expected: ("active" | "admission")[]
): void {
  expect(states).toEqual(expected);
}

async function expectAbortWithoutHttp(
  model: ChatCompletionsAgentModel,
  controller: AbortController,
  interrupt: () => void,
): Promise<void> {
  const pending = completeWithSignal(model, controller.signal);
  interrupt();
  expect(await captureRejection(pending)).toMatchObject({ name: "AbortError" });
}

test("prefers the Responses WebSocket for OpenAI API keys", async () => {
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

test("keeps admission bounded through unknown provider frames", async () => {
  const observedStates: ("active" | "admission")[] = [];
  const request = beginLifecycleRequest(observedStates);

  request.socket.receive({ type: "provider.keepalive" });
  expectRequestStates(observedStates, "admission");
  await expectRequestPending(request.pending);

  request.socket.receive({
    delta: "Done.",
    response_id: "current",
    type: "response.output_text.delta",
  });
  expectRequestStates(observedStates, "admission", "active");
  request.socket.receive({
    response: { id: "stale", output: [{ content: "Wrong" }] },
    type: "response.completed",
  });
  await expectRequestPending(request.pending);
  request.socket.receive(responseEvent("response.completed", "current"));
  expectDoneStep(await request.pending);
});

test("removes the abort listener after WebSocket success", async () => {
  const { controller, pending, socket } = instrumentedProviderRequest();
  expect(controller.abortListenerCount).toBe(1);
  acknowledgeProviderSocket(socket);
  socket.receive(COMPLETED_EVENT);

  await pending;
  expect(controller.abortListenerCount).toBe(0);
});

test("removes the abort listener after WebSocket abort", async () => {
  const { controller, pending, socket } = instrumentedProviderRequest();

  controller.abort();
  const error = await captureRejection(pending);
  expect(error).toBeInstanceOf(DOMException);
  expect(error instanceof DOMException ? error.name : "").toBe("AbortError");
  expect(controller.abortListenerCount).toBe(0);
  expectProviderSocketReleased(socket);
});

test("closes a fresh socket and releases listeners when send throws", async () => {
  const controller = new InstrumentedAbortController();
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

test("correlates realistic delta events on a reused WebSocket", async () => {
  const states: ("active" | "admission")[] = [];
  const { model, pending: first, socket } = beginLifecycleRequest(states);
  acknowledgeProviderSocket(socket, "response-1");
  expectRequestStates(states, "admission", "active");
  socket.receive(responseEvent("response.completed", "response-1"));
  await first;

  const controller = new AbortController();
  const stalled = model.complete(
    [{ content: "Continue", role: "user" }],
    controller.signal,
  );
  expect(socket.sent).toHaveLength(2);
  expectRequestStates(states, "admission", "active", "admission");
  expect(socket.listenerCount("message")).toBe(1);

  socket.receive(responseEvent("response.created", "response-1"));
  socket.receive({
    delta: "Stale",
    response_id: "response-1",
    type: "response.output_text.delta",
  });
  expectRequestStates(states, "admission", "active", "admission");
  await expectRequestPending(stalled);

  socket.receive({
    delta: "Done.",
    response_id: "response-2",
    type: "response.output_text.delta",
  });
  expectRequestStates(states, "admission", "active", "admission", "active");
  socket.receive({
    delta: " stale",
    response_id: "response-1",
    type: "response.output_text.delta",
  });
  socket.receive(responseEvent("response.completed", "response-2"));
  expectDoneStep(await stalled);
  socket.close();
  expectProviderSocketReleased(socket);
});

test("keeps an in-flight reused-request fence across a fresh socket reset", async () => {
  const transitions: ("active" | "admission")[] = [];
  const { model, sockets } = lifecycleModel(transitions);
  const first = complete(model);
  const reusedSocket = requireProviderSocket(sockets, 0);
  reusedSocket.open();
  acknowledgeProviderSocket(reusedSocket, "response-old");
  reusedSocket.receive(responseEvent("response.completed", "response-old"));
  await first;

  const reused = complete(model);
  const freshController = new AbortController();
  const fresh = completeWithSignal(model, freshController.signal);
  const freshSocket = requireProviderSocket(sockets, 1);
  freshSocket.open();
  reusedSocket.receive({
    delta: "Stale",
    response_id: "response-old",
    type: "response.output_text.delta",
  });
  await expectRequestPending(reused);

  acknowledgeProviderSocket(reusedSocket, "response-current");
  reusedSocket.receive(responseEvent("response.completed", "response-current"));
  expectDoneStep(await reused);
  freshController.abort();
  await expect(fresh).rejects.toMatchObject({ name: "AbortError" });
  reusedSocket.close();
});

test("rejects IDs from the full lifetime of a reused socket", async () => {
  const observed: ("active" | "admission")[] = [];
  const lifecycle = beginLifecycleRequest(observed);
  const { model, socket } = lifecycle;
  acknowledgeProviderSocket(socket, "response-0");
  socket.receive(responseEvent("response.completed", "response-0"));
  await lifecycle.pending;

  for (let generation = 1; generation <= 40; generation += 1) {
    const responseId = "response-" + String(generation);
    const pending = complete(model);
    acknowledgeProviderSocket(socket, responseId);
    socket.receive(responseEvent("response.completed", responseId));
    await pending;
  }

  const current = complete(model);
  socket.receive({
    delta: "Oldest generation stale",
    response_id: "response-0",
    type: "response.output_text.delta",
  });
  expect(observed.at(-1)).toBe("admission");
  expect(observed.filter((state) => state === "active")).toHaveLength(41);
  await expectRequestPending(current);
  socket.receive(responseEvent("response.created", "response-current"));
  socket.receive({
    delta: "Done.",
    response_id: "response-current",
    type: "response.output_text.delta",
  });
  socket.receive(responseEvent("response.completed", "response-current"));
  expectDoneStep(await current);
  socket.close();
});

test("reuses one WebSocket across steps and reconnects after idle close", async () => {
  // Deliberate: an early trial measured 0% cacheable-prefix reads through a
  // reused connection, but a live A/B re-test measured reuse and per-step
  // reconnects cache-neutral (~92% at hit, sporadic misses in both), so steps
  // share one socket, replace a dead connection, and close at run end.
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

test("retries transient failed events and clears partial output", async () => {
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

test("passes through permanent failed events without another socket", async () => {
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

test("falls back to HTTP after bounded transient failed events", () =>
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
