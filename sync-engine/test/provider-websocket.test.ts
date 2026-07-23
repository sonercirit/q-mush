import { expect, test, vi } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection } from "./promise-test-helpers.ts";
import { expectDoneTurn } from "./provider-turn-fixtures.ts";

const COMPLETED_EVENT = {
  response: {
    output: [
      {
        content: [{ text: "Done.", type: "output_text" }],
        role: "assistant",
        type: "message",
      },
    ],
  },
  type: "response.completed",
};

class FakeProviderSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState: number = WebSocket.CONNECTING;

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function complete(
  model: ChatCompletionsAgentModel,
  messages: readonly AgentConversationMessage[] = [
    { content: "Hello", role: "user" },
  ],
) {
  return model.complete(messages);
}

function neverFetch(): Promise<Response> {
  return Promise.reject(new Error("HTTP should not be used"));
}

function recordDelay(delays: number[]) {
  return (milliseconds: number): Promise<void> => {
    delays.push(milliseconds);
    return Promise.resolve();
  };
}

class FakeProviderSockets {
  readonly created: FakeProviderSocket[] = [];

  readonly create: WebSocketFactory = () => {
    const socket = new FakeProviderSocket();
    this.created.push(socket);
    return socket;
  };

  async closeAttempt(index: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.created).toHaveLength(index + 1);
    });
    this.created[index]?.close();
  }
}

function apiKeyOptions() {
  return {
    credential: {
      accountId: null,
      secret: "sk-openai",
      source: "api_key" as const,
    },
    model: "gpt-5.6",
    provider: "openai" as const,
  };
}

type WebSocketFactory = NonNullable<
  ConstructorParameters<typeof ChatCompletionsAgentModel>[0]["webSocket"]
>;

function apiKeyModel(options: {
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly webSocket: WebSocketFactory;
}): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...apiKeyOptions(),
    fetch: neverFetch,
    ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    webSocket: options.webSocket,
  });
}

function oauthModel(
  fetch: () => Promise<Response>,
  sleep: (milliseconds: number) => Promise<void>,
  webSocket: WebSocketFactory,
): ChatCompletionsAgentModel {
  const credential = {
    accountId: "chatgpt-account",
    secret: createOpenAiOAuthSecret(),
    source: "oauth" as const,
  };
  return new ChatCompletionsAgentModel({
    credential,
    fetch,
    model: "gpt-5-codex",
    provider: "openai",
    sleep,
    webSocket,
  });
}

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
    model: "gpt-5.6",
    store: false,
    type: "response.create",
  });
  expect(JSON.parse(socket?.sent[0] ?? "{}")).not.toHaveProperty("stream");
  socket?.receive({ type: "response.output_text.delta", delta: "Done." });
  socket?.receive(COMPLETED_EVENT);

  expectDoneTurn(await pending);
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

test("retries a partial WebSocket turn without persisting duplicate output", async () => {
  const sockets = new FakeProviderSockets();
  const deltas: ProviderTextDelta[] = [];
  const delays: number[] = [];
  const model = apiKeyModel({
    onDelta: (delta) => {
      deltas.push(delta);
    },
    sleep: recordDelay(delays),
    webSocket: sockets.create,
  });

  const pending = complete(model);
  sockets.created[0]?.open();
  sockets.created[0]?.receive({
    delta: "Partial",
    type: "response.output_text.delta",
  });
  sockets.created[0]?.fail();
  await vi.waitFor(() => {
    expect(sockets.created).toHaveLength(2);
  });
  expect(sockets.created[0]?.readyState).toBe(WebSocket.CLOSED);
  sockets.created[0]?.receive({
    delta: " stale",
    type: "response.output_text.delta",
  });
  sockets.created[1]?.open();
  sockets.created[1]?.receive({
    delta: "Done.",
    type: "response.output_text.delta",
  });
  sockets.created[1]?.receive(COMPLETED_EVENT);

  expectDoneTurn(await pending);
  const expectedDeltas: ProviderTextDelta[] = [
    { content: "Partial", thinking: "" },
    { content: "", reset: true, thinking: "" },
    { content: "Done.", thinking: "" },
  ];
  expect(deltas).toStrictEqual(expectedDeltas);
  expect(delays).toEqual([1_000]);
});

test("falls back to HTTP after bounded WebSocket retries", async () => {
  const sockets = new FakeProviderSockets();
  const delays: number[] = [];
  let fetchCount = 0;
  const fetch = (): Promise<Response> => {
    fetchCount += 1;
    const event = JSON.stringify(COMPLETED_EVENT);
    return Promise.resolve(new Response(`data: ${event}\n\ndata: [DONE]\n\n`));
  };
  const model = oauthModel(fetch, recordDelay(delays), sockets.create);

  const pending = complete(model);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sockets.closeAttempt(attempt);
  }

  expect(await pending).toMatchObject({ content: "Done." });
  expect(delays).toEqual([1_000, 2_000, 4_000]);
  expect(fetchCount).toBe(1);
});
