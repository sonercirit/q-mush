import { expect, test } from "bun:test";
import type { AgentConversationMessage } from "../agent-loop.ts";
import { ChatCompletionsAgentModel } from "../agent-model.ts";
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

function unavailableHttp(onFetch: () => void) {
  return () => {
    onFetch();
    return Promise.reject(new Error("HTTP should not be used"));
  };
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

function apiKeyModel(
  onFetch: () => void,
  webSocket: NonNullable<
    ConstructorParameters<typeof ChatCompletionsAgentModel>[0]["webSocket"]
  >,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    ...apiKeyOptions(),
    fetch: unavailableHttp(onFetch),
    webSocket,
  });
}

test("prefers the Responses WebSocket for OpenAI API keys", async () => {
  const sockets: FakeProviderSocket[] = [];
  let fetched = false;
  const model = apiKeyModel(
    () => {
      fetched = true;
    },
    (url, options) => {
      expect(url).toBe("wss://api.openai.com/v1/responses");
      expect(options.headers["authorization"]).toBe("Bearer sk-openai");
      const socket = new FakeProviderSocket();
      sockets.push(socket);
      return socket;
    },
  );

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
  expect(fetched).toBeFalse();
});

test("does not start an HTTP fallback after a WebSocket abort", async () => {
  const socket = new FakeProviderSocket();
  let fetched = false;
  const controller = new AbortController();
  const model = apiKeyModel(
    () => {
      fetched = true;
    },
    () => socket,
  );

  const pending = model.complete(
    [{ content: "Hello", role: "user" }],
    controller.signal,
  );
  socket.open();
  controller.abort();

  expect(await captureRejection(pending)).toMatchObject({ name: "AbortError" });
  expect(fetched).toBeFalse();
});

test("does not replay a partial WebSocket turn over HTTP", async () => {
  const socket = new FakeProviderSocket();
  const deltas: string[] = [];
  let fetched = false;
  const model = new ChatCompletionsAgentModel({
    ...apiKeyOptions(),
    fetch: () => {
      fetched = true;
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "Complete." } }] }),
      );
    },
    onDelta: ({ content }) => deltas.push(content),
    webSocket: () => socket,
  });

  const pending = complete(model);
  socket.open();
  socket.receive({ delta: "Partial", type: "response.output_text.delta" });
  socket.close();

  expect(await captureRejection(pending)).toMatchObject({
    message: "The provider WebSocket closed before completion",
  });
  expect(deltas).toEqual(["Partial"]);
  expect(fetched).toBeFalse();
});

test("falls back from an unavailable provider WebSocket to HTTP streaming", async () => {
  const socket = new FakeProviderSocket();
  const model = new ChatCompletionsAgentModel({
    credential: {
      accountId: "chatgpt-account",
      secret: createOpenAiOAuthSecret(),
      source: "oauth",
    },
    fetch: () =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify(COMPLETED_EVENT)}\n\ndata: [DONE]\n\n`,
        ),
      ),
    model: "gpt-5-codex",
    provider: "openai",
    webSocket: () => {
      return socket;
    },
  });

  const pending = complete(model);
  socket.close();

  expect(await pending).toMatchObject({ content: "Done." });
});
