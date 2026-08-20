import { REALTIME_PATH } from "../shared/routes.ts";
import {
  USER_REALTIME_MAX_PAYLOAD_LENGTH,
  type SESSION_REALTIME_OPERATIONS,
} from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import {
  readRealtimeServerEvent,
  type RealtimeServerEvent,
} from "./realtime-client-codec.ts";
import {
  commandFailure,
  MAXIMUM_PENDING_COMMAND_BYTES,
  MAXIMUM_PENDING_COMMANDS,
  normalizedCommandError,
  UNKNOWN_OUTCOME_ERROR,
  type PendingCommand,
  type QueuedCommand,
} from "./realtime-client-command.ts";
import {
  ToolSyncTracker,
  type ToolSyncRequest,
} from "./realtime-client-tool-sync.ts";
import {
  RealtimeStreamBuffer,
  type RealtimeClientEvent,
  type RealtimeStreamBarrier,
  type RealtimeStreamBatch,
} from "./realtime-stream-buffer.ts";
import { sessionIsActive } from "./session-controller-guards.ts";
interface BrowserWebSocket extends EventTarget {
  readonly readyState: number;
  close(): void;
  send(data: string): void;
}
type BrowserWebSocketFactory = (url: string) => BrowserWebSocket;
type FrameCallback = (callback: () => void) => number;
type RealtimeListener = (event: RealtimeClientEvent) => void;
type DeferredStateEvent = Extract<
  RealtimeServerEvent,
  {
    readonly type:
      | "runners"
      | "session"
      | "session_compaction_request"
      | "session_compaction_settled"
      | "session_questions"
      | "sessions"
      | "sessions_changed"
      | "tool_stream_snapshot";
  }
>;
const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;
const STREAM_UPDATES_PER_FRAME = 4;
const STREAM_PREP_BUDGET_MS = 8;
function noSelectedSession(): undefined {
  return undefined;
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
export class RealtimeConnection {
  readonly #createSocket: BrowserWebSocketFactory;
  readonly #listener: RealtimeListener;
  readonly #location: RealtimeLocation;
  readonly #now: () => number;
  readonly #requestFrame: FrameCallback;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #selected: () => string | undefined;
  readonly #clearTimeout: (id: number) => void;
  #instanceId: string | undefined;
  #hasConnected = false;
  #lastInstanceId: string | undefined;
  readonly #reconnects = new Set<() => void>();
  #commandBytes = 0;
  #pendingCommands = new Map<string, PendingCommand>();
  #queuedCommands: QueuedCommand[] = [];
  #reconnectAttempt = 0;
  #reconnectTimer: number | undefined;
  #stateEventGeneration = 0;
  #stateEventFrame: number | undefined;
  readonly #stateEvents = new Map<string, DeferredStateEvent>();
  readonly #stateBarriers = new Map<string, RealtimeStreamBarrier>();
  readonly #stateWaiters: ((available: boolean) => void)[] = [];
  #generation = 0;
  readonly #buffer = new RealtimeStreamBuffer();
  #streamFrame: number | undefined;
  #socket: BrowserWebSocket | undefined;
  readonly #toolSync = new ToolSyncTracker();
  #stopped = true;
  #workspaceId = GLOBAL_WORKSPACE_ID;
  constructor(
    listener: RealtimeListener,
    options: {
      readonly clearTimeout?: (id: number) => void;
      readonly createSocket?: BrowserWebSocketFactory;
      readonly location?: RealtimeLocation;
      readonly now?: () => number;
      readonly requestFrame?: FrameCallback;
      readonly selectedSession?: () => string | undefined;
      readonly setTimeout?: (callback: () => void, delay: number) => number;
    } = {},
  ) {
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#listener = listener;
    this.#location = options.location ?? window.location;
    this.#now = options.now ?? (() => performance.now());
    this.#requestFrame =
      options.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.#clearTimeout = options.clearTimeout ?? window.clearTimeout;
    this.#setTimeout = options.setTimeout ?? window.setTimeout;
    this.#selected = options.selectedSession ?? noSelectedSession;
  }
  onReconnect(listener: () => void): () => void {
    this.#reconnects.add(listener);
    return () => {
      this.#reconnects.delete(listener);
    };
  }
  yieldToStateApplication(): Promise<boolean> {
    return new Promise((resolve) => {
      this.#stateWaiters.push(resolve);
      this.#scheduleStateEvent();
    });
  }
  #sendToolSync(request: ToolSyncRequest): boolean {
    try {
      this.#socket?.send(JSON.stringify({ ...request, type: "sync_tools" }));
      return true;
    } catch {
      this.#socket?.close();
      return false;
    }
  }
  syncTools(sessionId: string): void {
    this.#syncTools(this.#buffer.activeToolStreams(sessionId));
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
    this.#commandBytes = 0;
    this.#instanceId = undefined;
    if (this.#reconnectTimer !== undefined) {
      this.#clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    this.#discardStateEvents();
    this.#generation += 1;
    this.#streamFrame = undefined;
    this.#buffer.clear();
    this.#toolSync.clear();
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
      bytes > MAXIMUM_PENDING_COMMAND_BYTES - this.#commandBytes
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
      this.#commandBytes += bytes;
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
        this.#commandBytes -= pending.bytes;
        reject(commandFailure(UNKNOWN_OUTCOME_ERROR));
        socket.close();
      }
    });
  }
  #clearDisconnectedStreams(): void {
    this.#generation += 1;
    this.#streamFrame = undefined;
    this.#buffer.clearPending();
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
        this.#discardStateEvents();
        this.#clearDisconnectedStreams();
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
  #stateEventKey(event: DeferredStateEvent): string {
    switch (event.type) {
      case "session":
        return `session:${event.session.id}`;
      case "session_questions":
        return `session_questions:${event.sessionId}`;
      case "session_compaction_request":
      case "session_compaction_settled":
        return `${event.type}:${event.sessionId}`;
      case "tool_stream_snapshot":
        return `${event.type}:${event.sessionId}:${event.streamId}`;
      case "runners":
      case "sessions":
      case "sessions_changed":
        return event.type;
    }
  }
  #discardStateEvents(): void {
    this.#stateEventGeneration += 1;
    this.#stateEventFrame = undefined;
    this.#stateEvents.clear();
    // Callers must immediately clear the stream buffer to discard these barriers.
    this.#stateBarriers.clear();
    for (const resolve of this.#stateWaiters.splice(0)) {
      resolve(false);
    }
  }
  #queueStateEvent(event: DeferredStateEvent): void {
    const key = this.#stateEventKey(event);
    this.#stateEvents.delete(key);
    this.#stateEvents.set(key, event);
    const sessionId =
      event.type === "session"
        ? event.session.id
        : "sessionId" in event
          ? event.sessionId
          : undefined;
    if (sessionId !== undefined) {
      const previousBarrier = this.#stateBarriers.get(key);
      if (previousBarrier !== undefined) {
        this.#buffer.releaseBarrier(previousBarrier);
      }
      this.#stateBarriers.set(key, this.#buffer.markBarrier(sessionId));
      this.#invalidateStreamFrame();
    }
    this.#scheduleStateEvent();
  }
  #scheduleStateEvent(): void {
    if (
      this.#stateEventFrame !== undefined ||
      (this.#stateEvents.size === 0 && this.#stateWaiters.length === 0)
    ) {
      return;
    }
    const generation = this.#stateEventGeneration;
    this.#stateEventFrame = this.#requestFrame(() => {
      this.#stateEventFrame = undefined;
      if (generation !== this.#stateEventGeneration || this.#stopped) {
        return;
      }
      const frameStartedAt = this.#now();
      const withinBudget = (): boolean =>
        this.#now() - frameStartedAt < STREAM_PREP_BUDGET_MS;
      while (withinBudget()) {
        const next = this.#stateEvents.entries().next();
        if (next.done) {
          this.#stateWaiters.shift()?.(true);
          break;
        }
        if (!this.#applyDeferredStateEntry(next.value, withinBudget)) break;
      }
      this.#scheduleStateEvent();
      this.#scheduleFrame();
    });
  }
  #applyDeferredStateEntry(
    [key, queued]: readonly [string, DeferredStateEvent],
    withinBudget: () => boolean,
  ): boolean {
    const barrier = this.#stateBarriers.get(key);
    if (barrier !== undefined) {
      const batch = this.#buffer.takeBarrier(
        barrier,
        STREAM_UPDATES_PER_FRAME,
        withinBudget,
      );
      this.#deliverStreamBatch(batch);
      if (batch !== undefined || this.#buffer.barrierPending(barrier)) {
        return false;
      }
    }
    this.#stateEvents.delete(key);
    this.#stateBarriers.delete(key);
    if (barrier !== undefined) this.#buffer.releaseBarrier(barrier);
    this.#deliverDeferredStateEvent(queued);
    return true;
  }
  #deliverDeferredStateEvent(event: DeferredStateEvent): void {
    if (event.type === "tool_stream_snapshot") {
      const snapshot = this.#buffer.applyToolSnapshot(event);
      this.#toolSync.resolve(event);
      this.#deliver(snapshot);
      return;
    }
    if (event.type === "session") {
      if (
        !sessionIsActive(event.session.status) &&
        event.session.status !== "paused"
      ) {
        this.#buffer.clearToolSession(event.session.id);
        this.#toolSync.resolveSession(event.session.id);
      } else {
        this.syncTools(event.session.id);
      }
    }
    this.#deliver(event);
  }
  #deliver(event: RealtimeClientEvent): void {
    this.#listener(event);
  }
  #deliverStreamBatch(batch: RealtimeStreamBatch | undefined): void {
    if (batch !== undefined) this.#deliver(batch);
  }
  #flushStreamFrame(): void {
    this.#streamFrame = undefined;
    if (!this.#stopped) {
      const frameStartedAt = this.#now();
      this.#deliverStreamBatch(
        this.#buffer.takeNext(
          STREAM_UPDATES_PER_FRAME,
          this.#selected(),
          () => this.#now() - frameStartedAt < STREAM_PREP_BUDGET_MS,
        ),
      );
      this.#scheduleFrame();
    }
  }
  #invalidateStreamFrame(): void {
    this.#generation += 1;
    this.#streamFrame = undefined;
  }
  #scheduleFrame(): void {
    if (
      this.#streamFrame !== undefined ||
      !this.#buffer.pending ||
      this.#stateEvents.size > 0
    ) {
      return;
    }
    const generation = this.#generation;
    this.#streamFrame = this.#requestFrame(() => {
      if (generation === this.#generation) {
        this.#flushStreamFrame();
      }
    });
  }
  #queueStreamDelta(
    event: Extract<
      RealtimeServerEvent,
      { readonly type: "session_delta" | "tool_stream" }
    >,
  ): void {
    this.#buffer.queue(event);
    const requests = this.#buffer.takeToolResyncRequests();
    this.#syncTools(requests);
    this.#scheduleFrame();
  }
  #syncTools(requests: readonly ToolSyncRequest[]): void {
    const unresolved = this.#toolSync.unresolved(requests);
    for (const [index, request] of unresolved.entries()) {
      if (!this.#sendToolSync(request)) {
        for (const remaining of unresolved.slice(index)) {
          this.#toolSync.remember(remaining);
        }
        return;
      }
      // A sent request stays pending until its matching snapshot arrives.
      this.#toolSync.remember(request);
    }
  }
  #rejectPendingCommands(code: string): void {
    for (const pending of this.#pendingCommands.values()) {
      pending.reject(commandFailure(code));
      this.#commandBytes -= pending.bytes;
    }
    this.#pendingCommands.clear();
  }
  #rejectQueuedCommands(code: string): void {
    for (const queued of this.#queuedCommands) {
      queued.pending.reject(commandFailure(code));
      this.#commandBytes -= queued.pending.bytes;
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
    this.#commandBytes -= pending.bytes;
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
        const remembered = this.#toolSync.pending();
        this.#toolSync.clear();
        this.#syncTools([
          ...remembered,
          ...this.#buffer.activeToolStreams(),
          ...this.#buffer.takeToolResyncRequests(),
        ]);
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
          this.#commandBytes -= pending.bytes;
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
        for (const listener of this.#reconnects) {
          listener();
        }
      }
      this.#deliver(event);
      return;
    }
    if (event.type === "command_success" || event.type === "command_error") {
      this.#settleCommand(event);
      this.#deliver(event);
      return;
    }
    if (event.type === "health") {
      this.#listener(event);
      return;
    }
    if (event.type === "session_delta" || event.type === "tool_stream") {
      this.#queueStreamEvent(event);
      return;
    }
    this.#queueStateEvent(event);
  }
  #queueStreamEvent(
    event: Extract<
      RealtimeServerEvent,
      { type: "session_delta" | "tool_stream" }
    >,
  ): void {
    if (
      event.type === "tool_stream" &&
      event.state !== undefined &&
      event.state !== "preparing" &&
      event.state !== "running"
    ) {
      this.#toolSync.resolve(event);
    }
    this.#queueStreamDelta(event);
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
