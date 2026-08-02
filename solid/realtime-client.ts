import { REALTIME_PATH } from "../shared/routes.ts";
import {
  type SESSION_REALTIME_OPERATIONS,
  USER_REALTIME_MAX_PAYLOAD_LENGTH,
} from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
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
type SessionDelta = Extract<
  RealtimeServerEvent,
  { readonly type: "session_delta" }
>;
type ToolDelta = Extract<RealtimeServerEvent, { readonly type: "tool_stream" }>;
type CoalescedDelta = SessionDelta | ToolDelta;
type DeferredStateEvent = Extract<
  RealtimeServerEvent,
  {
    readonly type:
      | "runners"
      | "session"
      | "session_questions"
      | "sessions"
      | "sessions_changed";
  }
>;

const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;
const MAXIMUM_PENDING_COMMANDS = 1_000;
const MAXIMUM_PENDING_COMMAND_BYTES = 128 * 1024 * 1024;
const UNKNOWN_OUTCOME_ERROR = "outcome_unknown";

function normalizedCommandError(error: string): string {
  return error === "command_outcome_unknown" || error === UNKNOWN_OUTCOME_ERROR
    ? UNKNOWN_OUTCOME_ERROR
    : error;
}

function commandFailure(
  code: string,
  detail?: string,
): Error & { readonly code: string } {
  return Object.assign(new Error(detail ?? code), { code });
}

interface RealtimeLocation {
  readonly href: string;
  readonly protocol: string;
}

function realtimeUrl(location: RealtimeLocation, workspaceId: string): string {
  const url = new URL(REALTIME_PATH, location.href);
  if (workspaceId !== GLOBAL_WORKSPACE_ID) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

interface PendingCommand {
  readonly bytes: number;
  readonly envelope: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  sentInstanceId: string | undefined;
}

interface QueuedCommand {
  readonly commandId: string;
  readonly pending: PendingCommand;
}

function rememberToolSnapshot(
  snapshots: Map<string, Readonly<{ sessionId: string; streamId: string }>>,
  sessionId: string,
  streamId: string | undefined,
): void {
  if (streamId !== undefined) {
    snapshots.set(sessionId, { sessionId, streamId });
  }
}

export class RealtimeConnection {
  readonly #createSocket: BrowserWebSocketFactory;
  readonly #listener: RealtimeListener;
  readonly #location: RealtimeLocation;
  readonly #requestFrame: FrameCallback;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (id: number) => void;
  #instanceId: string | undefined;
  #hasConnected = false;
  #lastInstanceId: string | undefined;
  readonly #reconnectListeners = new Set<() => void>();
  #pendingCommandBytes = 0;
  #pendingCommands = new Map<string, PendingCommand>();
  #queuedCommands: QueuedCommand[] = [];
  #reconnectAttempt = 0;
  #reconnectTimer: number | undefined;
  #deferredStateEventGeneration = 0;
  #deferredStateEventFrame: number | undefined;
  readonly #deferredStateEvents = new Map<string, DeferredStateEvent>();
  readonly #deferredStateWaiters: ((available: boolean) => void)[] = [];
  #sessionDeltaGeneration = 0;
  #sessionDeltas = new Map<string, CoalescedDelta[]>();
  #sessionDeltaFrame: number | undefined;
  #socket: BrowserWebSocket | undefined;
  readonly #toolSnapshotRequests = new Map<
    string,
    { readonly sessionId: string; readonly streamId: string }
  >();
  #stopped = true;
  #workspaceId = GLOBAL_WORKSPACE_ID;

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

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => {
      this.#reconnectListeners.delete(listener);
    };
  }

  yieldToStateApplication(): Promise<boolean> {
    return new Promise((resolve) => {
      this.#deferredStateWaiters.push(resolve);
      this.#scheduleDeferredStateEvent();
    });
  }

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

  start(workspaceId = this.#workspaceId): void {
    if (!this.#stopped) {
      return;
    }

    this.#workspaceId = workspaceId;

    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#hasConnected = false;
    this.#lastInstanceId = undefined;

    this.#rejectQueuedCommands(UNKNOWN_OUTCOME_ERROR);
    this.#rejectPendingCommands(UNKNOWN_OUTCOME_ERROR);
    this.#pendingCommandBytes = 0;
    this.#instanceId = undefined;

    if (this.#reconnectTimer !== undefined) {
      this.#clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }

    const socket = this.#socket;
    this.#socket = undefined;
    this.#discardDeferredStateEvents();
    this.#sessionDeltaGeneration += 1;
    this.#sessionDeltaFrame = undefined;
    this.#sessionDeltas.clear();
    this.#toolSnapshotRequests.clear();
    socket?.close();
  }

  command(
    operation: (typeof SESSION_REALTIME_OPERATIONS)[keyof typeof SESSION_REALTIME_OPERATIONS],
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<unknown> {
    const commandId = crypto.randomUUID();
    let envelope: string;
    try {
      envelope = JSON.stringify({
        commandId,
        idempotencyKey,
        operation,
        payload,
        type: "command",
      });
    } catch {
      return Promise.reject(new Error("invalid_command"));
    }
    const bytes = utf8ByteLength(envelope);
    if (bytes >= USER_REALTIME_MAX_PAYLOAD_LENGTH) {
      return Promise.reject(new Error("command_too_large"));
    }
    const socket = this.#socket;
    if (
      this.#queuedCommands.length + this.#pendingCommands.size >=
        MAXIMUM_PENDING_COMMANDS ||
      bytes > MAXIMUM_PENDING_COMMAND_BYTES - this.#pendingCommandBytes
    ) {
      return Promise.reject(new Error("command_capacity_exceeded"));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        bytes,
        envelope,
        reject,
        resolve,
        sentInstanceId: undefined,
      };
      this.#pendingCommandBytes += bytes;
      if (
        socket?.readyState !== WebSocket.OPEN ||
        this.#instanceId === undefined
      ) {
        this.#queuedCommands.push({ commandId, pending });
        return;
      }
      pending.sentInstanceId = this.#instanceId;
      this.#pendingCommands.set(commandId, pending);
      try {
        socket.send(envelope);
      } catch {
        this.#pendingCommands.delete(commandId);
        this.#pendingCommandBytes -= pending.bytes;
        reject(commandFailure(UNKNOWN_OUTCOME_ERROR));
        socket.close();
      }
    });
  }

  #connect(): void {
    if (this.#stopped) {
      return;
    }

    let socket: BrowserWebSocket;
    try {
      socket = this.#createSocket(
        realtimeUrl(this.#location, this.#workspaceId),
      );
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (
        this.#socket !== socket ||
        this.#stopped ||
        socket.readyState !== WebSocket.OPEN
      ) {
        socket.close();
        return;
      }
      this.#reconnectAttempt = 0;
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
        const decoded = readRealtimeServerEvent(event.data);
        if (this.#instanceId === undefined && decoded.type !== "ready") {
          throw new Error("The realtime server was not ready");
        }
        if (this.#instanceId !== undefined && decoded.type === "ready") {
          throw new Error("The realtime server sent a duplicate handshake");
        }
        this.#receive(decoded);
      } catch {
        socket.close();
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#instanceId = undefined;
        this.#discardDeferredStateEvents();
        this.#rejectPendingCommands(UNKNOWN_OUTCOME_ERROR);
        if (!this.#hasConnected && this.#queuedCommands.length > 0) {
          this.#rejectQueuedCommands(UNKNOWN_OUTCOME_ERROR);
        }
        this.#scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket && !this.#stopped) {
        socket.close();
      }
    });
  }

  #deferredStateEventKey(event: DeferredStateEvent): string {
    switch (event.type) {
      case "session":
        return `session:${event.session.id}`;
      case "session_questions":
        return `session_questions:${event.sessionId}`;
      case "runners":
      case "sessions":
      case "sessions_changed":
        return event.type;
    }
  }

  #discardDeferredStateEvents(): void {
    this.#deferredStateEventGeneration += 1;
    this.#deferredStateEventFrame = undefined;
    this.#deferredStateEvents.clear();
    for (const resolve of this.#deferredStateWaiters.splice(0)) {
      resolve(false);
    }
  }

  #queueDeferredStateEvent(event: DeferredStateEvent): void {
    this.#deferredStateEvents.set(this.#deferredStateEventKey(event), event);
    this.#scheduleDeferredStateEvent();
  }

  #scheduleDeferredStateEvent(): void {
    if (
      this.#deferredStateEventFrame !== undefined ||
      (this.#deferredStateEvents.size === 0 &&
        this.#deferredStateWaiters.length === 0)
    ) {
      return;
    }

    const generation = this.#deferredStateEventGeneration;
    this.#deferredStateEventFrame = this.#requestFrame(() => {
      this.#deferredStateEventFrame = undefined;
      if (generation !== this.#deferredStateEventGeneration || this.#stopped) {
        return;
      }
      const next = this.#deferredStateEvents.entries().next();
      if (next.done) {
        this.#deferredStateWaiters.shift()?.(true);
      } else {
        const [key, queued] = next.value;
        this.#deferredStateEvents.delete(key);
        this.#listener(queued);
      }
      this.#scheduleDeferredStateEvent();
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
    this.#sessionDeltas.delete(key);
    for (const delta of deltas ?? []) {
      this.#listener(delta);
    }
  }

  #queueSessionDelta(event: CoalescedDelta): void {
    const key =
      event.type === "session_delta"
        ? `session:${event.sessionId}`
        : `tool:${event.sessionId}:${event.streamId}:${String(event.index)}`;
    const queued =
      event.type === "session_delta" && event.reset
        ? []
        : (this.#sessionDeltas.get(key) ?? []);
    const previous = queued.at(-1);
    let combined: CoalescedDelta = event;
    if (
      event.type === "session_delta" &&
      previous?.type === "session_delta" &&
      previous.streamId === event.streamId
    ) {
      combined = {
        ...event,
        ...(previous.reset === true ? { reset: true } : {}),
        content: previous.content + event.content,
        thinking: previous.thinking + event.thinking,
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

  #rejectPendingCommands(code: string): void {
    for (const pending of this.#pendingCommands.values()) {
      pending.reject(commandFailure(code));
      this.#pendingCommandBytes -= pending.bytes;
    }
    this.#pendingCommands.clear();
  }

  #rejectQueuedCommands(code: string): void {
    for (const queued of this.#queuedCommands) {
      queued.pending.reject(commandFailure(code));
      this.#pendingCommandBytes -= queued.pending.bytes;
    }
    this.#queuedCommands = [];
  }

  #settleCommand(
    event: Extract<
      RealtimeServerEvent,
      { readonly type: "command_error" | "command_success" }
    >,
  ): void {
    const pending = this.#pendingCommands.get(event.commandId);
    if (pending === undefined) {
      return;
    }
    this.#pendingCommands.delete(event.commandId);
    this.#pendingCommandBytes -= pending.bytes;
    if (event.type === "command_success") {
      pending.resolve(event.result);
    } else {
      const code = normalizedCommandError(event.error);
      pending.reject(commandFailure(code, event.detail));
    }
  }

  #receive(event: RealtimeServerEvent): void {
    if (event.type === "ready") {
      const reconnected = this.#hasConnected;
      const previousInstanceId = this.#lastInstanceId;
      this.#hasConnected = true;
      this.#instanceId = event.instanceId;
      this.#lastInstanceId = event.instanceId;
      const socket = this.#socket;
      if (socket?.readyState === WebSocket.OPEN) {
        const queued = this.#queuedCommands;
        this.#queuedCommands = [];
        for (const { commandId, pending } of queued) {
          pending.sentInstanceId = event.instanceId;
          this.#pendingCommands.set(commandId, pending);
        }
        for (const request of this.#toolSnapshotRequests.values()) {
          socket.send(JSON.stringify({ ...request, type: "sync_tools" }));
        }
      }
      const pendingCommandIds = [...this.#pendingCommands.keys()];
      for (const commandId of pendingCommandIds) {
        const pending = this.#pendingCommands.get(commandId);
        if (pending === undefined) {
          continue;
        }
        if (
          pending.sentInstanceId !== undefined &&
          pending.sentInstanceId !== event.instanceId &&
          previousInstanceId !== event.instanceId
        ) {
          this.#pendingCommands.delete(commandId);
          this.#pendingCommandBytes -= pending.bytes;
          pending.reject(commandFailure(UNKNOWN_OUTCOME_ERROR));
          continue;
        }
        const activeSocket = this.#socket;
        if (activeSocket?.readyState === WebSocket.OPEN) {
          pending.sentInstanceId = event.instanceId;
          try {
            activeSocket.send(pending.envelope);
          } catch {
            activeSocket.close();
          }
        }
      }
      if (reconnected) {
        for (const listener of this.#reconnectListeners) {
          listener();
        }
      }
      this.#listener(event);
      return;
    }
    if (event.type === "command_success" || event.type === "command_error") {
      this.#settleCommand(event);
      this.#listener(event);
      return;
    }
    if (event.type === "health") {
      this.#listener(event);
      return;
    }
    if (event.type === "session_compaction_request") {
      this.#flushSessionDelta(`session:${event.sessionId}`);
      this.#listener(event);
      return;
    }
    if (event.type === "session_delta" || event.type === "tool_stream") {
      this.#queueStreamEvent(event);
      return;
    }

    if (event.type === "tool_stream_snapshot") {
      this.#queueStreamEvent(event);
      this.#flushToolDeltas(event.sessionId);
      this.#listener(event);
      return;
    }
    if (event.type === "session") {
      const key = `session:${event.session.id}`;
      this.#flushSessionDelta(key);
      this.#flushToolDeltas(event.session.id);
      if (
        event.session.status !== "queued" &&
        event.session.status !== "running"
      ) {
        this.#toolSnapshotRequests.delete(event.session.id);
      } else {
        this.syncTools(event.session.id);
      }
    }
    this.#queueDeferredStateEvent(event);
  }

  #queueStreamEvent(
    event: Extract<
      RealtimeServerEvent,
      { type: "session_delta" | "tool_stream" | "tool_stream_snapshot" }
    >,
  ): void {
    rememberToolSnapshot(
      this.#toolSnapshotRequests,
      event.sessionId,
      event.streamId,
    );
    if (event.type !== "tool_stream_snapshot") {
      this.#queueSessionDelta(event);
    }
  }

  #flushToolDeltas(sessionId: string): void {
    for (const key of [...this.#sessionDeltas.keys()]) {
      if (key.startsWith(`tool:${sessionId}:`)) {
        this.#flushSessionDelta(key);
      }
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
