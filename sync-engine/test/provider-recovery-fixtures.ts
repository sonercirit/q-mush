import { expect, vi } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { RecordingTestSocket } from "../../shared/test/websocket-fixtures.ts";
import type { ModelRequestSleep } from "../../sync-engine/agent-model-retry.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import { codexOAuthCredential } from "./prompt-cache-fixtures.ts";

export const COMPLETED_EVENT = {
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

const USER_MESSAGE = [{ content: "Hello", role: "user" as const }];

export class FakeProviderSocket extends RecordingTestSocket {
  constructor() {
    super({
      closeEvent: () => new CloseEvent("close", { code: 1000 }),
      readyState: WebSocket.CONNECTING,
    });
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}

type WebSocketFactory = NonNullable<
  ConstructorParameters<typeof ChatCompletionsAgentModel>[0]["webSocket"]
>;

export function complete(
  model: ChatCompletionsAgentModel,
  messages: readonly AgentConversationMessage[] = USER_MESSAGE,
) {
  return model.complete(messages);
}

function neverFetch(): Promise<Response> {
  return Promise.reject(new Error("HTTP should not be used"));
}

export function providerDelta(
  content: string,
  reset = false,
): ProviderTextDelta {
  return { content, ...(reset ? { reset: true } : {}), thinking: "" };
}

function collectDelta(deltas: ProviderTextDelta[]): {
  readonly onDelta: (delta: ProviderTextDelta) => void;
} {
  return {
    onDelta: (delta) => {
      deltas.push(delta);
    },
  };
}

function recordDelay(delays: number[]): ModelRequestSleep {
  return async (milliseconds) => {
    await Promise.resolve();
    delays.push(milliseconds);
  };
}

export class FakeProviderSockets {
  readonly created: FakeProviderSocket[] = [];

  readonly create: WebSocketFactory = () => {
    const socket = new FakeProviderSocket();
    this.created.push(socket);
    return socket;
  };

  async closeAttempt(index: number): Promise<void> {
    await this.waitForAttempt(index);
    this.created[index]?.close();
  }

  async waitForAttempt(index: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.created).toHaveLength(index + 1);
    });
  }
}

interface RetryingSocketSetup {
  readonly delays: number[];
  readonly deltas: ProviderTextDelta[];
  readonly pending: ReturnType<typeof complete>;
  readonly sockets: FakeProviderSockets;
}

export function retryingSocket(): RetryingSocketSetup {
  const deltas: ProviderTextDelta[] = [];
  const delays: number[] = [];
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({
    ...collectDelta(deltas),
    sleep: recordDelay(delays),
    webSocket: sockets.create,
  });
  return { delays, deltas, pending: complete(model), sockets };
}

export function apiKeyModel(options: {
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly sleep?: ModelRequestSleep;
  readonly webSocket: WebSocketFactory;
}): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: {
      accountId: null,
      secret: "sk-openai",
      source: "api_key",
    },
    fetch: neverFetch,
    model: "api-test-model",
    ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
    provider: "openai",
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    webSocket: options.webSocket,
  });
}

function oauthModel(
  fetch: () => Promise<Response>,
  sleep: ModelRequestSleep,
  webSocket: WebSocketFactory,
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: codexOAuthCredential(),
    fetch,
    model: "gpt-5-codex",
    provider: "openai",
    sleep,
    webSocket,
  });
}

export function completedEventResponse(): Response {
  const event = JSON.stringify(COMPLETED_EVENT);
  return new Response(`data: ${event}\n\ndata: [DONE]\n\n`);
}

export async function failWebSocketAttempts(
  sockets: FakeProviderSockets,
  failAttempt: (socket: FakeProviderSocket, index: number) => void = (
    socket,
  ) => {
    socket.fail();
  },
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sockets.waitForAttempt(attempt);
    const socket = sockets.created[attempt];
    if (socket !== undefined) {
      failAttempt(socket, attempt);
    }
  }
}

export async function expectBoundedHttpFallback(options: {
  readonly failAttempt: (socket: FakeProviderSocket, index: number) => void;
}): Promise<void> {
  const sockets = new FakeProviderSockets();
  const delays: number[] = [];
  let fetchCount = 0;
  const model = oauthModel(
    () => {
      fetchCount += 1;
      return Promise.resolve(completedEventResponse());
    },
    recordDelay(delays),
    sockets.create,
  );
  const pending = complete(model);

  await failWebSocketAttempts(sockets, options.failAttempt);

  expect(await pending).toMatchObject({ content: "Done." });
  expect(delays).toEqual([1_000, 2_000, 4_000]);
  expect(fetchCount).toBe(1);
}
