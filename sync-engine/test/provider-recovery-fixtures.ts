import { expect, vi } from "vitest";
import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import { RecordingTestSocket } from "../../shared/test/websocket-fixtures.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import type { ModelRequestSleep } from "../../sync-engine/agent-model-retry.ts";
import { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import type { ProviderRequestLifecycleOptions } from "../../sync-engine/provider-request-lifecycle.ts";
import type { ProviderTextDelta } from "../../sync-engine/provider-stream.ts";
import {
  TEST_CREDENTIAL_FINGERPRINT,
  testApiKeyCredential,
} from "./agent-model-credential-fixtures.ts";
import { codexOAuthCredential } from "./prompt-cache-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

export const OPENAI_AUTHENTICATION_ERROR_EVENT = {
  error: {
    code: "invalid_api_key",
    message: "Incorrect API key provided",
    type: "authentication_error",
  },
  type: "error",
};

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
  closeCode: number | undefined;
  closeCount = 0;
  closeReason: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly #listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  constructor(headers: Readonly<Record<string, string>> = {}) {
    super({
      closeEvent: () => new CloseEvent("close", { code: 1000 }),
      readyState: WebSocket.CONNECTING,
    });
    this.headers = headers;
  }

  #changeListener(
    action: "add" | "remove",
    type: string,
    callback: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    if (action === "add") {
      listeners.add(callback);
      this.#listeners.set(type, listeners);
      return;
    }
    listeners.delete(callback);
    if (listeners.size === 0) this.#listeners.delete(type);
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback !== null) this.#changeListener("add", type, callback);
  }

  override close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeCount += 1;
    this.closeReason = reason;
    super.close();
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback !== null) this.#changeListener("remove", type, callback);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
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

export function expectProviderSocketReleased(socket: FakeProviderSocket): void {
  expect(socket.closeCount).toBe(1);
  expect(
    ["open", "message", "error", "close"].map((type) =>
      socket.listenerCount(type),
    ),
  ).toEqual([0, 0, 0, 0]);
}

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

export function recordDelay(delays: number[]): ModelRequestSleep {
  return async (milliseconds) => {
    await Promise.resolve();
    delays.push(milliseconds);
  };
}

export class FakeProviderSockets {
  readonly created: FakeProviderSocket[] = [];

  readonly create: WebSocketFactory = (_url, options) => {
    const socket = new FakeProviderSocket(options.headers);
    this.created.push(socket);
    return socket;
  };

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

export function requireProviderSocket(
  sockets: FakeProviderSockets,
  index: number,
): FakeProviderSocket {
  const socket = sockets.created[index];
  if (socket === undefined) {
    throw new Error(`Provider socket ${String(index)} was not created`);
  }
  return socket;
}

export async function openAndRejectProviderSocket(
  sockets: FakeProviderSockets,
  index: number,
): Promise<FakeProviderSocket> {
  await sockets.waitForAttempt(index);
  const socket = requireProviderSocket(sockets, index);
  socket.open();
  socket.receive(OPENAI_AUTHENTICATION_ERROR_EVENT);
  return socket;
}

export function acknowledgeProviderSocket(
  socket: FakeProviderSocket,
  responseId = "response-complete",
): void {
  socket.receive({ response: { id: responseId }, type: "response.created" });
}

export function completeProviderSocket(
  socket: FakeProviderSocket,
  responseId: string,
): void {
  socket.receive({
    ...COMPLETED_EVENT,
    response: { ...COMPLETED_EVENT.response, id: responseId },
  });
}

export function expireProviderSocket(
  socket: FakeProviderSocket,
  code: string,
  retryAfterSeconds?: number,
): void {
  socket.receive({
    error: {
      code,
      message:
        "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
      ...(retryAfterSeconds === undefined
        ? {}
        : { retry_after: retryAfterSeconds }),
      type: "invalid_request_error",
    },
    status: 400,
    type: "error",
  });
}

export async function replaceProviderSocket(
  sockets: FakeProviderSockets,
  index = 1,
): Promise<void> {
  await sockets.waitForAttempt(index);
  const replacement = requireProviderSocket(sockets, index);
  replacement.open();
  acknowledgeProviderSocket(replacement);
  replacement.receive(COMPLETED_EVENT);
}

export function retryingSocket(): RetryingSocketSetup {
  const deltas: ProviderTextDelta[] = [];
  const delays: number[] = [];
  const sockets = new FakeProviderSockets();
  const collectDelta = (delta: ProviderTextDelta): void => {
    deltas.push(delta);
  };
  const modelOptions = {
    onDelta: collectDelta,
    sleep: recordDelay(delays),
    webSocket: sockets.create,
  };
  const model = apiKeyModel(modelOptions);
  return { delays, deltas, pending: complete(model), sockets };
}

export function apiKeyModel(
  options: ProviderRequestLifecycleOptions & {
    readonly fetch?: () => Promise<Response>;
    readonly sleep?: ModelRequestSleep;
    readonly webSocket: WebSocketFactory;
  },
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: testApiKeyCredential("sk-openai", { id: "test-credential" }),
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    fetch: options.fetch ?? neverFetch,
    maxOutputTokens: null,
    model: "api-test-model",
    ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
    onRequestState: options.onRequestState ?? (() => undefined),
    provider: "openai",
    toolSettings: DEFAULT_TOOL_SETTINGS,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    webSocket: options.webSocket,
  });
}

function oauthModel(
  fetch: () => Promise<Response>,
  sleep: ModelRequestSleep,
  webSocket: WebSocketFactory,
  states?: ("active" | "admission")[],
): ChatCompletionsAgentModel {
  return new ChatCompletionsAgentModel({
    credential: codexOAuthCredential(),
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    fetch,
    maxOutputTokens: null,
    model: "gpt-5-codex",
    ...(states === undefined
      ? {}
      : {
          onRequestState: (state: "active" | "admission") => states.push(state),
        }),
    provider: "openai",
    sleep,
    toolSettings: DEFAULT_TOOL_SETTINGS,
    webSocket,
  });
}

export function chatCompletedResponse(): Response {
  const chunk = JSON.stringify({
    choices: [{ message: { content: "Done." } }],
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`);
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
  const states: ("active" | "admission")[] = [];
  const model = oauthModel(
    () => {
      fetchCount += 1;
      return Promise.resolve(completedEventResponse());
    },
    recordDelay(delays),
    sockets.create,
    states,
  );
  const pending = complete(model);

  await failWebSocketAttempts(sockets, options.failAttempt);

  const step = await pending;
  expect(fetchCount).toBe(1);
  expect(states.filter((state) => state === "admission")).toHaveLength(4);
  expect(states.at(-1)).toBe("active");
  expect(delays).toEqual([1_000, 2_000, 4_000]);
  expectDoneStep(step);
}
