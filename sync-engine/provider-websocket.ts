import type { AgentModelTurn } from "../shared/agent-loop.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "./provider-stream.ts";

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

export class ProviderWebSocketError extends Error {
  readonly started: boolean;

  constructor(message: string, started: boolean) {
    super(message);
    this.name = "ProviderWebSocketError";
    this.started = started;
  }
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

export function completeProviderWebSocket(options: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly createSocket: ProviderWebSocketFactory;
  readonly headers: Readonly<Record<string, string>>;
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly onEvent?: (event: unknown) => void;
  readonly signal?: AbortSignal;
  readonly url: string;
}): Promise<AgentModelTurn> {
  if (options.signal?.aborted === true) {
    return Promise.reject(abortError());
  }

  return new Promise<AgentModelTurn>((resolve, reject) => {
    const accumulator = createProviderStreamAccumulator(
      "responses",
      options.onDelta,
    );
    let opened = false;
    let receivedEvent = false;
    let settled = false;
    const socket = options.createSocket(options.url, {
      headers: options.headers,
    });
    const settle = (error: Error | undefined, turn?: AgentModelTurn): void => {
      if (settled) {
        return;
      }

      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined && turn !== undefined) {
        resolve(turn);
      } else {
        reject(error ?? new Error("The provider returned no model turn"));
      }
    };
    const fail = (error: Error): void => {
      settle(error);
    };
    const failUnknown = (error: unknown): void => {
      fail(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = (): void => {
      fail(abortError());
      socket.close(1000, "Aborted");
    };

    socket.addEventListener("open", () => {
      try {
        socket.send(
          JSON.stringify({ ...options.body, type: "response.create" }),
        );
        opened = true;
      } catch (error) {
        failUnknown(error);
      }
    });
    socket.addEventListener("message", (event) => {
      if (settled) {
        return;
      }
      try {
        const value: unknown = JSON.parse(messageText(event));
        options.onEvent?.(value);
        accumulator.push(value);
        receivedEvent = true;

        if (accumulator.completed) {
          settle(undefined, accumulator.finish());
          socket.close(1000, "Complete");
        }
      } catch (error) {
        socket.close(1002, "Invalid provider message");
        failUnknown(error);
      }
    });
    socket.addEventListener("error", () => {
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
    });
    socket.addEventListener("close", () => {
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
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
