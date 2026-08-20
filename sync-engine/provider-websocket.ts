import type { AgentModelStep } from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import { ProviderStreamError } from "./provider-error.ts";
import type { ProviderRequestLifecycleOptions } from "./provider-request-lifecycle.ts";
import { createProviderStreamAccumulator } from "./provider-stream.ts";

interface ProviderWebSocket extends EventTarget {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface ProviderWebSocketOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export type ProviderWebSocketFactory = (
  url: string,
  options: ProviderWebSocketOptions,
) => ProviderWebSocket;

const OPEN_STATE = 1;

export class ProviderWebSocketError extends Error {
  readonly reconnectImmediately: boolean;
  readonly retryAfterMilliseconds: number | undefined;
  readonly started: boolean;

  constructor(
    message: string,
    started: boolean,
    options: ProviderWebSocketErrorOptions = {},
  ) {
    super(message);
    this.name = "ProviderWebSocketError";
    this.reconnectImmediately = options.reconnectImmediately === true;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds;
    this.started = started;
  }
}

interface ProviderWebSocketErrorOptions {
  readonly reconnectImmediately?: boolean;
  readonly retryAfterMilliseconds?: number | undefined;
}

function abortError(): DOMException {
  return new DOMException("The model request was aborted", "AbortError");
}

function messageText(event: Event): string {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    throw new Error("The provider WebSocket returned a non-text message");
  }

  return event.data;
}

function providerResponseId(
  event: Readonly<Record<string, unknown>>,
): string | undefined {
  const responseId = event["response_id"];
  if (typeof responseId === "string" && responseId.length > 0) {
    return responseId;
  }
  const response = event["response"];
  const id = isRecord(response) ? response["id"] : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

interface ProviderWebSocketRequest extends ProviderRequestLifecycleOptions {
  readonly body: Readonly<Record<string, unknown>>;
  readonly createSocket: ProviderWebSocketFactory;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly url: string;
}

// A session keeps one provider socket open across sequential steps: a live
// A/B re-test measured reuse and per-step reconnects cache-neutral (~92%
// cacheable-prefix reads at hit, sporadic misses in both — the early
// 0%-on-reuse reading did not reproduce), so reuse saves a TLS and WebSocket
// handshake per step. Failed or aborted requests close the socket; the next
// step reconnects.
export class ProviderWebSocketSession {
  readonly #priorResponseIds = new Set<string>();
  #socket: ProviderWebSocket | undefined;
  #socketGeneration = 0;

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#socketGeneration += 1;
    this.#priorResponseIds.clear();
    socket?.close(1000, "Session complete");
  }

  #takeOpenSocket(): ProviderWebSocket | undefined {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined) {
      return undefined;
    }
    if (socket.readyState === OPEN_STATE) {
      return socket;
    }
    socket.close(1000, "Connection expired");
    return undefined;
  }

  complete(options: ProviderWebSocketRequest): Promise<AgentModelStep> {
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    options.onRequestState?.("admission");

    return new Promise<AgentModelStep>((resolve, reject) => {
      const accumulator = createProviderStreamAccumulator(
        "responses",
        options.onDelta,
      );
      const requestGeneration = ++this.#socketGeneration;
      const reusedSocket = this.#takeOpenSocket();
      const socket =
        reusedSocket ??
        options.createSocket(options.url, { headers: options.headers });
      const priorResponseIds =
        reusedSocket === undefined
          ? new Set<string>()
          : new Set(this.#priorResponseIds);
      if (reusedSocket === undefined) this.#priorResponseIds.clear();
      let currentResponseId: string | undefined;
      let opened = reusedSocket !== undefined;
      let receivedEvent = false;
      let requestActive = false;
      let settled = false;
      const settle = (
        error: Error | undefined,
        step?: AgentModelStep,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        // Only a successfully completed step leaves this socket reusable, so
        // failed or aborted steps cannot expose its older response ID.
        if (error === undefined && step !== undefined) {
          if (requestGeneration === this.#socketGeneration) {
            this.#priorResponseIds.clear();
            for (const id of priorResponseIds) this.#priorResponseIds.add(id);
            if (currentResponseId !== undefined) {
              this.#priorResponseIds.add(currentResponseId);
            }
            this.#socket = socket;
          } else {
            socket.close(1000, "Connection superseded");
          }
          resolve(step);
        } else {
          reject(error ?? new Error("The provider returned no model step"));
        }
      };
      const fail = (error: Error): void => {
        settle(error);
      };
      const failUnknown = (error: unknown): void => {
        if (
          error instanceof ProviderStreamError &&
          (error.transient || error.reconnectWebSocket)
        ) {
          fail(
            new ProviderWebSocketError(error.message, receivedEvent, {
              reconnectImmediately: error.reconnectWebSocket,
              retryAfterMilliseconds: error.reconnectWebSocket
                ? undefined
                : error.retryAfterMilliseconds,
            }),
          );
          return;
        }
        fail(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = (): void => {
        fail(abortError());
        socket.close(1000, "Aborted");
      };
      const onOpen = (): void => {
        try {
          socket.send(
            JSON.stringify({ ...options.body, type: "response.create" }),
          );
          opened = true;
        } catch (error) {
          if (reusedSocket === undefined) {
            failUnknown(error);
            socket.close(1011, "Provider connection failed");
            return;
          }
          // A reused socket that rejects a send died between steps; surface
          // the transient connection error so the caller reconnects.
          fail(
            new ProviderWebSocketError(
              "The provider WebSocket connection was unavailable",
              receivedEvent,
            ),
          );
          socket.close(1011, "Provider connection failed");
        }
      };
      const onMessage = (event: Event): void => {
        if (settled) {
          return;
        }
        let invalidProviderMessage = true;
        try {
          const value: unknown = JSON.parse(messageText(event));
          invalidProviderMessage = false;
          if (!isRecord(value)) {
            return;
          }
          const eventResponseId = providerResponseId(value);
          if (!requestActive) {
            if (value["type"] === "error") {
              // Provider error events generally carry no response ID, so they
              // cannot participate in the stale-response fence. Treat them as
              // applying to the sole sequential request on this socket.
              accumulator.push(value);
              return;
            }
            const eventType = value["type"];
            const responseEvent =
              typeof eventType === "string" &&
              eventType.startsWith("response.");
            const retainedResponse =
              eventResponseId !== undefined &&
              priorResponseIds.has(eventResponseId);
            const admitsRequest =
              responseEvent &&
              !retainedResponse &&
              (reusedSocket === undefined ||
                eventResponseId !== undefined ||
                eventType === "response.created");
            if (!admitsRequest) {
              return;
            }
            // response.created is the canonical correlation event. Servers
            // that omit it can still correlate the request with an identified
            // non-terminal event; an unfamiliar terminal frame alone may be a
            // stale response from the reused connection and is discarded.
            currentResponseId = eventResponseId;
            requestActive = true;
            options.onRequestState?.("active");
          } else if (
            eventResponseId !== undefined &&
            currentResponseId === undefined
          ) {
            currentResponseId = eventResponseId;
          } else if (
            eventResponseId !== undefined &&
            eventResponseId !== currentResponseId
          ) {
            return;
          }
          accumulator.push(value);
          receivedEvent = true;

          if (accumulator.completed) {
            settle(undefined, accumulator.finish());
          }
        } catch (error) {
          failUnknown(error);
          socket.close(
            invalidProviderMessage ? 1002 : 1011,
            invalidProviderMessage
              ? "Invalid provider message"
              : "Provider request failed",
          );
        }
      };
      const onError = (): void => {
        if (settled) {
          return;
        }
        fail(
          new ProviderWebSocketError(
            "The provider WebSocket connection failed",
            receivedEvent,
          ),
        );
        socket.close(1011, "Provider connection failed");
      };
      const onClose = (): void => {
        if (!settled) {
          fail(
            new ProviderWebSocketError(
              opened
                ? "The provider WebSocket closed before completion"
                : "The provider WebSocket connection was unavailable",
              receivedEvent,
            ),
          );
        }
      };

      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      options.signal?.addEventListener("abort", onAbort);
      if (reusedSocket === undefined) {
        socket.addEventListener("open", onOpen);
      } else {
        onOpen();
      }
    });
  }
}
