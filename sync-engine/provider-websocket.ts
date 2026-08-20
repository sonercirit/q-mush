import type { AgentModelStep } from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  ProviderStreamError,
  readProviderStreamError,
} from "./provider-error.ts";
import type { ProviderRequestLifecycleOptions } from "./provider-request-lifecycle.ts";
import { createProviderStreamAccumulator } from "./provider-stream.ts";

function uncorrelatedError(
  message: string,
  started: boolean,
): ProviderWebSocketError {
  return new ProviderWebSocketError(message, started, {
    reconnectImmediately: true,
  });
}

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
// Bun documents 16 MiB as the default `Bun.serve` WebSocket
// `maxPayloadLength`, not as a client WebSocket limit. Borrow that documented
// transport-scale value as an application memory budget for the client fence;
// crossing it retires the socket without evicting IDs or weakening the fence.
const MAX_RETAINED_RESPONSE_ID_BYTES = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();

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
  // A provider controls response-ID length and request completion rate, so the
  // documented 60-minute socket lifetime cannot by itself bound this fence.
  // Retain at most the explicit memory budget above, then retire rather than
  // evicting an ID and reopening the stale-frame admission race. Observed
  // OpenAI `resp_…` IDs are about 53 bytes; correctness does not rely on that.
  #priorResponseIdBytes = 0;
  #priorResponseIds = new Set<string>();
  #socket: ProviderWebSocket | undefined;
  #socketGeneration = 0;

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#socketGeneration += 1;
    this.#priorResponseIds.clear();
    this.#priorResponseIdBytes = 0;
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
        reusedSocket === undefined ? new Set<string>() : this.#priorResponseIds;
      let retainedBytes =
        reusedSocket === undefined ? 0 : this.#priorResponseIdBytes;
      // Transfer the fence to this request. The session field accumulates no
      // duplicate copy while the request owns the only reusable socket.
      this.#priorResponseIds = new Set<string>();
      this.#priorResponseIdBytes = 0;
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
            if (currentResponseId === undefined) {
              socket.close(1000, "Unidentified response complete");
            } else {
              if (!priorResponseIds.has(currentResponseId)) {
                priorResponseIds.add(currentResponseId);
                retainedBytes +=
                  textEncoder.encode(currentResponseId).byteLength;
              }
              if (retainedBytes <= MAX_RETAINED_RESPONSE_ID_BYTES) {
                this.#priorResponseIds = priorResponseIds;
                this.#priorResponseIdBytes = retainedBytes;
                this.#socket = socket;
              } else {
                socket.close(1000, "Response ID retention limit reached");
              }
            }
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
              if (
                reusedSocket !== undefined &&
                eventResponseId !== undefined &&
                priorResponseIds.has(eventResponseId)
              ) {
                return;
              }
              if (reusedSocket !== undefined) {
                const providerError = readProviderStreamError(value);
                if (!providerError.transient) {
                  accumulator.push(value);
                  return;
                }
                // An uncorrelated error can be a delayed frame from the prior
                // response. Retire the reused socket and replay this request
                // on a fresh connection rather than assigning stale failure.
                fail(
                  uncorrelatedError(
                    "The reused provider WebSocket returned an uncorrelated error",
                    false,
                  ),
                );
                socket.close(1011, "Uncorrelated provider error");
                return;
              }
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
            // response.created is canonical. Otherwise, a fresh socket's
            // response event or an identified non-retained response event
            // correlates the request; unidentified events on a reused socket
            // are potentially stale and discarded.
            currentResponseId = eventResponseId;
            requestActive = true;
            options.onRequestState?.("active");
          } else if (
            reusedSocket !== undefined &&
            value["type"] === "error" &&
            eventResponseId === undefined &&
            !readProviderStreamError(value).reconnectWebSocket
          ) {
            fail(
              uncorrelatedError(
                "The provider WebSocket returned an uncorrelated error",
                receivedEvent,
              ),
            );
            socket.close(1011, "Uncorrelated provider error");
            return;
          } else if (
            eventResponseId !== undefined &&
            currentResponseId === undefined
          ) {
            if (priorResponseIds.has(eventResponseId)) {
              return;
            }
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
