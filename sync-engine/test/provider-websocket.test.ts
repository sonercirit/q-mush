import { expect, test } from "vitest";
import type { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { captureRejection } from "./promise-test-helpers.ts";
import {
  apiKeyModel,
  chatCompletedResponse,
  complete,
  COMPLETED_EVENT,
  createProviderSockets,
  expectBoundedHttpFallback,
  expireProviderSocket,
  FakeProviderSocket,
  FakeProviderSockets,
  providerDelta,
  recordProviderDelay,
  replaceProviderSocket,
  requireProviderSocket,
  retryingSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

async function expectAbortWithoutHttp(
  model: ChatCompletionsAgentModel,
  controller: AbortController,
  interrupt: () => void,
): Promise<void> {
  const pending = model.complete(
    [{ content: "Hello", role: "user" }],
    controller.signal,
  );
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
  socket?.receive({ type: "response.output_text.delta", delta: "Done." });
  socket?.receive(COMPLETED_EVENT);

  expectDoneStep(await pending);
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
  socket?.receive(COMPLETED_EVENT);
  expectDoneStep(await first);

  const second = complete(model);
  expect(socket?.sent).toHaveLength(2);
  socket?.receive(COMPLETED_EVENT);
  expectDoneStep(await second);
  expect(stepSockets.created).toHaveLength(1);

  socket?.close();
  const third = complete(model);
  await stepSockets.waitForAttempt(1);
  const reconnected = stepSockets.created[1];
  reconnected?.open();
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
    expired.receive({
      delta: "Partial",
      type: "response.output_text.delta",
    });
    expireProviderSocket(expired, code);

    await replaceProviderSocket(sockets);
    const replacement = sockets.created[1];

    expectDoneStep(await pending);
    expect(expired.readyState).toBe(WebSocket.CLOSED);
    expect(replacement?.sent).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(deltas).toEqual([providerDelta("Partial"), providerDelta("", true)]);
  },
);

test("keeps ordinary retry capacity after an immediate expiry reconnect", async () => {
  const retry = retryingSocket();
  const { delays, pending } = retry;
  const expired = requireProviderSocket(retry.sockets, 0);
  expired.open();
  expireProviderSocket(expired, "websocket_connection_limit_reached");
  await retry.sockets.waitForAttempt(1);
  retry.sockets.created[1]?.fail();
  await replaceProviderSocket(retry.sockets, 2);

  expectDoneStep(await pending);
  expect(delays[0]).toBe(1_000);
});

test("bounds repeated connection-limit reconnects", async () => {
  const { delays, sockets } = createProviderSockets();
  const model = apiKeyModel({
    fetch: () => Promise.resolve(chatCompletedResponse()),
    sleep: recordProviderDelay(delays),
    webSocket: sockets.create,
  });
  const pending = complete(model);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sockets.waitForAttempt(attempt);
    const expired = requireProviderSocket(sockets, attempt);
    expired.open();
    expireProviderSocket(expired, "websocket_connection_limit_reached");
  }

  expect(delays).toEqual([1_000, 2_000, 4_000]);
  expect({
    socketCount: sockets.created.length,
    step: await pending,
  }).toMatchObject({ socketCount: 5, step: { content: "Done." } });
});

test("retries partial output after a socket error without stale deltas", async () => {
  const { delays, deltas, pending, sockets } = retryingSocket();
  const partialSocket = sockets.created[0];
  partialSocket?.open();
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
