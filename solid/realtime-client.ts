import { REALTIME_PATH } from "../shared/routes.ts";
import {
  readRealtimeServerEvent,
  type RealtimeServerEvent,
} from "./realtime-client-codec.ts";

interface BrowserWebSocket extends EventTarget {
  readonly readyState: number;
  close(): void;
  send(data: string): void;
}

type BrowserWebSocketFactory = (url: string) => BrowserWebSocket;
type FrameCallback = (callback: () => void) => number;
type RealtimeListener = (event: RealtimeServerEvent) => void;
type ToolSnapshot = Extract<
  RealtimeServerEvent,
  { readonly type: "tool_stream_snapshot" }
>;
type ToolSnapshotRequest = Pick<ToolSnapshot, "sessionId" | "streamId">;
type SessionDelta = Extract<
  RealtimeServerEvent,
  { readonly type: "session_delta" }
>;
type ToolDelta = Extract<RealtimeServerEvent, { readonly type: "tool_stream" }>;
type CoalescedDelta = SessionDelta | ToolDelta;

const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;

interface RealtimeLocation {
  readonly href: string;
  readonly protocol: string;
}

function realtimeUrl(location: RealtimeLocation): string {
  const url = new URL(REALTIME_PATH, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class RealtimeConnection {
  readonly #createSocket: BrowserWebSocketFactory;
  readonly #listener: RealtimeListener;
  readonly #location: RealtimeLocation;
  readonly #requestFrame: FrameCallback;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (id: number) => void;
  #reconnectAttempt = 0;
  #reconnectTimer: number | undefined;
  #sessionDeltaGeneration = 0;
  #sessionDeltas = new Map<string, CoalescedDelta[]>();
  #sessionDeltaFrame: number | undefined;
  #socket: BrowserWebSocket | undefined;
  readonly #toolSnapshotRequests = new Map<string, ToolSnapshotRequest>();
  #stopped = true;

  syncTools(sessionId: string): void {
    const request = this.#toolSnapshotRequests.get(sessionId);
    if (request === undefined) {
      return;
    }
    try {
      this.#socket?.send(JSON.stringify({ ...request, type: "sync_tools" }));
    } catch {
      this.#socket?.close();
    }
  }

  constructor(
    listener: RealtimeListener,
    options: {
      readonly clearTimeout?: (id: number) => void;
      readonly createSocket?: BrowserWebSocketFactory;
      readonly location?: RealtimeLocation;
      readonly requestFrame?: FrameCallback;
      readonly setTimeout?: (callback: () => void, delay: number) => number;
    } = {},
  ) {
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#listener = listener;
    this.#location = options.location ?? window.location;
    this.#requestFrame =
      options.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.#clearTimeout = options.clearTimeout ?? window.clearTimeout;
    this.#setTimeout = options.setTimeout ?? window.setTimeout;
  }

  start(): void {
    if (!this.#stopped) {
      return;
    }

    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;

    if (this.#reconnectTimer !== undefined) {
      this.#clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }

    const socket = this.#socket;
    this.#socket = undefined;
    this.#sessionDeltaGeneration += 1;
    this.#sessionDeltaFrame = undefined;
    this.#sessionDeltas.clear();
    this.#toolSnapshotRequests.clear();
    socket?.close();
  }

  #connect(): void {
    if (this.#stopped) {
      return;
    }

    let socket: BrowserWebSocket;
    try {
      socket = this.#createSocket(realtimeUrl(this.#location));
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#reconnectAttempt = 0;
      try {
        socket.send(JSON.stringify({ type: "refresh" }));
        for (const request of this.#toolSnapshotRequests.values()) {
          socket.send(JSON.stringify({ ...request, type: "sync_tools" }));
        }
      } catch {
        socket.close();
      }
    });
    socket.addEventListener("message", (event) => {
      if (event instanceof MessageEvent && typeof event.data === "string") {
        try {
          this.#receive(readRealtimeServerEvent(event.data));
        } catch {
          socket.close();
        }
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  #flushSessionDelta(key?: string): void {
    if (key === undefined) {
      this.#sessionDeltaFrame = undefined;
      const deltas = [...this.#sessionDeltas.values()].flat();
      this.#sessionDeltas.clear();
      if (this.#stopped) {
        return;
      }
      for (const delta of deltas) {
        this.#listener(delta);
      }
      return;
    }

    const deltas = this.#sessionDeltas.get(key);
    if (deltas !== undefined) {
      this.#sessionDeltas.delete(key);
      for (const delta of deltas) {
        this.#listener(delta);
      }
    }
  }

  #queueSessionDelta(event: CoalescedDelta): void {
    const key =
      event.type === "session_delta"
        ? `session:${event.sessionId}`
        : `tool:${event.sessionId}:${event.streamId}:${String(event.index)}`;
    const existingQueue = this.#sessionDeltas.get(key) ?? [];
    const queued =
      event.type === "session_delta" && event.reset ? [] : existingQueue;
    const previous = queued.at(-1);
    let combined: CoalescedDelta = event;
    if (
      event.type === "session_delta" &&
      previous?.type === "session_delta" &&
      !event.reset &&
      previous.streamId === event.streamId
    ) {
      combined = {
        ...event,
        ...(previous.reset === true ? { reset: true } : {}),
        content: previous.content + event.content,
        thinking: previous.thinking + event.thinking,
      };
    } else if (
      event.type === "tool_stream" &&
      previous?.type === "tool_stream" &&
      event.callId === previous.callId &&
      event.sequence === previous.sequence + 1 &&
      event.channel !== undefined &&
      event.channel === previous.channel &&
      event.state === undefined &&
      previous.state === undefined
    ) {
      combined = {
        ...event,
        content: (previous.content ?? "") + (event.content ?? ""),
        sequenceStart: previous.sequenceStart ?? previous.sequence,
      };
    }
    this.#sessionDeltas.set(
      key,
      previous === undefined || combined === event
        ? [...queued, event]
        : [...queued.slice(0, -1), combined],
    );
    if (this.#sessionDeltaFrame !== undefined) {
      return;
    }

    const generation = this.#sessionDeltaGeneration;
    this.#sessionDeltaFrame = this.#requestFrame(() => {
      if (generation === this.#sessionDeltaGeneration) {
        this.#flushSessionDelta();
      }
    });
  }

  #flushSessionTools(sessionId: string): void {
    for (const key of [...this.#sessionDeltas.keys()]) {
      if (key.startsWith(`tool:${sessionId}:`)) {
        this.#flushSessionDelta(key);
      }
    }
  }

  #receive(event: RealtimeServerEvent): void {
    if (event.type === "tool_stream" || event.type === "tool_stream_snapshot") {
      this.#toolSnapshotRequests.set(event.sessionId, {
        sessionId: event.sessionId,
        streamId: event.streamId,
      });
    } else if (
      event.type === "session" &&
      event.session.status !== "queued" &&
      event.session.status !== "running"
    ) {
      this.#toolSnapshotRequests.delete(event.session.id);
    } else if (event.type === "session" && event.session.status === "running") {
      this.syncTools(event.session.id);
    }
    if (event.type === "session_delta" || event.type === "tool_stream") {
      this.#queueSessionDelta(event);
      return;
    }
    if (event.type === "tool_stream_snapshot") {
      this.#flushSessionTools(event.sessionId);
    } else if (event.type === "session") {
      this.#flushSessionDelta(`session:${event.session.id}`);
      this.#flushSessionTools(event.session.id);
    }
    this.#listener(event);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) {
      return;
    }

    const delay =
      RECONNECT_DELAYS[
        Math.min(this.#reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ] ?? 5_000;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }
}
