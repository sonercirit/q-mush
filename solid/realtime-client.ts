import { REALTIME_PATH } from "../shared/routes.ts";
import type { UserRealtimeCommand } from "../shared/user-realtime-protocol.ts";
import {
  readRealtimeServerEvent,
  type RealtimeServerEvent,
} from "./realtime-client-codec.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

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

interface RealtimeCommandError {
  readonly code: string;
}

interface PendingCommand {
  readonly command: UserRealtimeCommand;
  readonly reject: (error: RealtimeCommandError) => void;
  readonly resolve: (result: unknown) => void;
}

const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;
let commandSequence = 0;

interface RealtimeLocation {
  readonly href: string;
  readonly protocol: string;
}

function realtimeUrl(location: RealtimeLocation): string {
  const url = new URL(REALTIME_PATH, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    listener();
  }
}

function commandIdentifier(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${commandSequence.toString(36)}`;
}

export class RealtimeConnection implements SessionCommandTransport {
  readonly #clearTimeout: (id: number) => void;
  readonly #createSocket: BrowserWebSocketFactory;
  readonly #listener: RealtimeListener;
  readonly #location: RealtimeLocation;
  readonly #reconnectListeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #requestFrame: FrameCallback;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  #reconnectAttempt = 0;
  #reconnectTimer: number | undefined;
  #hasOpened = false;
  #sessionDeltaGeneration = 0;
  #sessionDeltas = new Map<string, SessionDelta>();
  #sessionDeltaFrame: number | undefined;
  #socket: BrowserWebSocket | undefined;
  #stopped = true;

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

  command(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey = commandIdentifier("mutation"),
  ): Promise<unknown> {
    const command: UserRealtimeCommand = {
      commandId: commandIdentifier("command"),
      idempotencyKey,
      operation,
      payload,
      type: "command",
    };
    return new Promise(
      (resolve, reject: (error: RealtimeCommandError) => void) => {
        this.#pending.set(command.commandId, { command, reject, resolve });
        this.#send(command);
      },
    );
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => {
      this.#reconnectListeners.delete(listener);
    };
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
    for (const pending of this.#pending.values()) {
      pending.reject({ code: "connection_stopped" });
    }
    this.#pending.clear();
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
      if (this.#socket !== socket || this.#stopped) {
        socket.close();
        return;
      }
      this.#reconnectAttempt = 0;
      const reconnecting = this.#hasOpened;
      this.#hasOpened = true;
      for (const pending of this.#pending.values()) {
        this.#send(pending.command, socket);
      }
      if (reconnecting) {
        notifyListeners(this.#reconnectListeners);
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || this.#stopped) {
        return;
      }
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
        socket.close();
        return;
      }
      try {
        const acknowledgement = this.#readAcknowledgement(event.data);
        if (acknowledgement) {
          return;
        }
        this.#receive(readRealtimeServerEvent(event.data));
      } catch {
        socket.close();
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

  #readAcknowledgement(message: string): boolean {
    const value: unknown = JSON.parse(message);
    if (typeof value !== "object" || value === null || !("type" in value)) {
      return false;
    }
    if (value.type !== "command_success" && value.type !== "command_error") {
      return false;
    }
    if (!("commandId" in value) || typeof value.commandId !== "string") {
      throw new Error("The realtime command acknowledgement was invalid");
    }
    const pending = this.#pending.get(value.commandId);
    if (pending === undefined) {
      return true;
    }
    if (value.type === "command_error") {
      const error = "error" in value ? value.error : undefined;
      if (typeof error !== "string") {
        throw new Error(
          "The realtime command error acknowledgement was invalid",
        );
      }
      this.#settlePending(value.commandId, () => {
        pending.reject({ code: error });
      });
      return true;
    }
    if (!("result" in value)) {
      throw new Error(
        "The realtime command success acknowledgement was invalid",
      );
    }
    this.#settlePending(value.commandId, () => {
      pending.resolve(value.result);
    });
    return true;
  }

  #settlePending(commandId: string, settle: () => void): void {
    this.#pending.delete(commandId);
    settle();
  }

  #send(command: UserRealtimeCommand, socket = this.#socket): void {
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(command));
    } catch {
      socket.close();
    }
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
    if (event.type === "session_delta") {
      this.#queueSessionDelta(event);
      return;
    }
    if (event.type === "session") {
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
