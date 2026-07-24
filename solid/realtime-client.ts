import { REALTIME_PATH } from "../shared/routes.ts";
import {
  readRealtimeServerEvent,
  type RealtimeServerEvent,
} from "./realtime-client-codec.ts";
import { RealtimeCompactionQueue } from "./realtime-compaction-queue.ts";

interface BrowserWebSocket extends EventTarget {
  readonly readyState: number;
  close(): void;
  send(data: string): void;
}

type BrowserWebSocketFactory = (url: string) => BrowserWebSocket;
type FrameCallback = (callback: () => void) => number;
type RealtimeListener = (event: RealtimeServerEvent) => void;
type SessionDelta = Extract<
  RealtimeServerEvent,
  { readonly type: "session_delta" }
>;

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
  readonly #compactionSnapshot: () => void;
  readonly #compactions: RealtimeCompactionQueue;
  readonly #createSocket: BrowserWebSocketFactory;
  readonly #listener: RealtimeListener;
  readonly #location: RealtimeLocation;
  readonly #requestFrame: FrameCallback;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (id: number) => void;
  #reconnectAttempt = 0;
  #reconnectTimer: number | undefined;
  #sessionDeltaGeneration = 0;
  #sessionDeltas = new Map<string, SessionDelta>();
  #sessionDeltaFrame: number | undefined;
  #socket: BrowserWebSocket | undefined;
  #stopped = true;

  constructor(
    listener: RealtimeListener,
    options: {
      readonly clearTimeout?: (id: number) => void;
      readonly compactionSnapshot?: () => void;
      readonly createSocket?: BrowserWebSocketFactory;
      readonly location?: RealtimeLocation;
      readonly requestFrame?: FrameCallback;
      readonly setTimeout?: (callback: () => void, delay: number) => number;
    } = {},
  ) {
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#compactionSnapshot = options.compactionSnapshot ?? (() => undefined);
    this.#listener = listener;
    this.#location = options.location ?? window.location;
    this.#requestFrame =
      options.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.#clearTimeout = options.clearTimeout ?? window.clearTimeout;
    this.#setTimeout = options.setTimeout ?? window.setTimeout;
    this.#compactions = new RealtimeCompactionQueue(
      this.#listener,
      this.#requestFrame,
      this.#compactionSnapshot,
    );
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
    this.#compactions.reset();
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
        this.#compactions.reset();
        this.#scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  #flushSessionDelta(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#sessionDeltaFrame = undefined;
      const deltas = [...this.#sessionDeltas.values()];
      this.#sessionDeltas.clear();
      if (this.#stopped) {
        return;
      }
      for (const delta of deltas) {
        this.#listener(delta);
      }
      return;
    }

    const delta = this.#sessionDeltas.get(sessionId);
    this.#sessionDeltas.delete(sessionId);
    if (delta !== undefined) {
      this.#listener(delta);
    }
  }

  #queueSessionDelta(event: SessionDelta): void {
    const current = event.reset
      ? undefined
      : this.#sessionDeltas.get(event.sessionId);
    let combined = event;
    if (current !== undefined) {
      const fragments = [current, event];
      combined = {
        ...event,
        ...(current.reset === true ? { reset: true } : {}),
        content: fragments.map(({ content }) => content).join(""),
        thinking: fragments.map(({ thinking }) => thinking).join(""),
      };
    }
    this.#sessionDeltas.set(event.sessionId, combined);
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

  #receive(event: RealtimeServerEvent): void {
    if (event.type === "session_compaction") {
      this.#compactions.push(event);
      return;
    }
    if (event.type === "session_delta") {
      this.#queueSessionDelta(event);
      return;
    }
    if (event.type === "session") {
      this.#compactions.flushSession(event.session.id);
      const hadQueuedDelta = this.#sessionDeltas.has(event.session.id);
      this.#flushSessionDelta(event.session.id);
      if (hadQueuedDelta) {
        this.#sessionDeltaGeneration += 1;
        this.#sessionDeltaFrame = undefined;
        this.#rescheduleSessionDeltaFrame();
      }
    }
    this.#listener(event);
  }

  #rescheduleSessionDeltaFrame(): void {
    if (this.#sessionDeltas.size === 0) {
      return;
    }
    const queued = this.#sessionDeltas;
    this.#sessionDeltas = new Map();
    for (const delta of queued.values()) {
      this.#queueSessionDelta(delta);
    }
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
