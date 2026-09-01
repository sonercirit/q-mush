import { USER_REALTIME_MAX_PAYLOAD_LENGTH } from "../shared/user-realtime-protocol.ts";
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
  deferredStateEventKey,
  noSelectedSession,
  realtimeUrl,
  RECONNECT_DELAYS,
  STREAM_PREP_BUDGET_MS,
  STREAM_UPDATES_PER_FRAME,
  type DeferredStateEvent,
  type RealtimeLocation,
} from "./realtime-client-configuration.ts";
import type {
  BrowserWebSocket,
  BrowserWebSocketFactory,
  FrameCallback,
  RealtimeListener,
  SessionRealtimeOperation,
} from "./realtime-client-contract.ts";
import {
  createToolSyncTracker,
  type ToolSyncRequest,
  type ToolSyncTracker,
} from "./realtime-client-tool-sync.ts";
import {
  createRealtimeStreamBuffer,
  type RealtimeClientEvent,
  type RealtimeStreamBarrier,
  type RealtimeStreamBatch,
  type RealtimeStreamBuffer,
} from "./realtime-stream-buffer.ts";
import { sessionIsActive } from "./session-controller-guards.ts";
export interface RealtimeConnection {
  command(
    operation: SessionRealtimeOperation,
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  readonly onReconnect: (listener: () => void) => () => void;
  readonly start: (workspaceId?: string) => void;
  readonly stop: () => void;
  readonly syncTools: (sessionId: string) => void;
  readonly yieldToStateApplication: () => Promise<boolean>;
}

interface RealtimeConnectionOptions {
  readonly clearTimeout?: (id: number) => void;
  readonly createSocket?: BrowserWebSocketFactory;
  readonly location?: RealtimeLocation;
  readonly now?: () => number;
  readonly requestFrame?: FrameCallback;
  readonly selectedSession?: () => string | undefined;
  readonly streamBuffer?: RealtimeStreamBuffer;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly toolSync?: ToolSyncTracker;
}

export function createRealtimeConnection(
  listener: RealtimeListener,
  options: RealtimeConnectionOptions = {},
): RealtimeConnection {
  const buffer = options.streamBuffer ?? createRealtimeStreamBuffer();
  const createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  const location = options.location ?? window.location;
  const now = options.now ?? (() => performance.now());
  const requestFrame =
    options.requestFrame ??
    ((callback) => window.requestAnimationFrame(callback));
  const clearTimeout =
    options.clearTimeout ??
    ((handle) => {
      window.clearTimeout(handle);
    });
  const setTimeout =
    options.setTimeout ??
    ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
  const selected = options.selectedSession ?? noSelectedSession;
  const toolSync = options.toolSync ?? createToolSyncTracker();
  let instanceId: string | undefined;
  let hasConnected = false;
  let lastInstanceId: string | undefined;
  const reconnects = new Set<() => void>();
  let commandBytes = 0;
  const pendingCommands = new Map<string, PendingCommand>();
  let queuedCommands: QueuedCommand[] = [];
  let reconnectAttempt = 0;
  let reconnectTimer: number | undefined;
  let stateEventGeneration = 0;
  let stateEventFrame: number | undefined;
  const stateEvents = new Map<string, DeferredStateEvent>();
  const stateBarriers = new Map<string, RealtimeStreamBarrier>();
  const stateWaiters: ((available: boolean) => void)[] = [];
  let generation = 0;
  let streamFrame: number | undefined;
  let socket: BrowserWebSocket | undefined;
  let stopped = true;
  let workspaceId = GLOBAL_WORKSPACE_ID;
  function onReconnect(listener: () => void): () => void {
    const registeredReconnects = reconnects;
    registeredReconnects.add(listener);
    return () => {
      registeredReconnects.delete(listener);
    };
  }
  function yieldToStateApplication(): Promise<boolean> {
    return new Promise((resolve) => {
      stateWaiters.push(resolve);
      scheduleStateEvent();
    });
  }
  function sendToolSync(request: ToolSyncRequest): boolean {
    try {
      socket?.send(JSON.stringify({ ...request, type: "sync_tools" }));
      return true;
    } catch {
      socket?.close();
      return false;
    }
  }
  function syncTools(sessionId: string): void {
    syncToolRequests(buffer.activeToolStreams(sessionId));
  }
  function start(nextWorkspaceId = workspaceId): void {
    if (!stopped) {
      return;
    }
    workspaceId = nextWorkspaceId;
    stopped = false;
    connect();
  }
  function stop(): void {
    stopped = true;
    hasConnected = false;
    lastInstanceId = undefined;
    rejectQueuedCommands(UNKNOWN_OUTCOME_ERROR);
    rejectPendingCommands(UNKNOWN_OUTCOME_ERROR);
    commandBytes = 0;
    instanceId = undefined;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const activeSocket = socket;
    socket = undefined;
    discardStateEvents();
    generation += 1;
    streamFrame = undefined;
    buffer.clear();
    toolSync.clear();
    activeSocket?.close();
  }
  function command(
    operation: SessionRealtimeOperation,
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
    const activeSocket = socket;
    if (
      queuedCommands.length + pendingCommands.size >=
        MAXIMUM_PENDING_COMMANDS ||
      bytes > MAXIMUM_PENDING_COMMAND_BYTES - commandBytes
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
      commandBytes += bytes;
      if (
        activeSocket?.readyState !== WebSocket.OPEN ||
        instanceId === undefined
      ) {
        queuedCommands.push({ commandId, pending });
        return;
      }
      pending.sentInstanceId = instanceId;
      pendingCommands.set(commandId, pending);
      try {
        activeSocket.send(envelope);
      } catch {
        pendingCommands.delete(commandId);
        commandBytes -= pending.bytes;
        reject(commandFailure(UNKNOWN_OUTCOME_ERROR));
        activeSocket.close();
      }
    });
  }
  function clearDisconnectedStreams(): void {
    generation += 1;
    streamFrame = undefined;
    buffer.clearPending();
  }
  function connect(): void {
    if (stopped) {
      return;
    }
    let connectedSocket: BrowserWebSocket;
    try {
      connectedSocket = createSocket(realtimeUrl(location, workspaceId));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = connectedSocket;
    connectedSocket.addEventListener("open", () => {
      if (
        socket !== connectedSocket ||
        stopped ||
        connectedSocket.readyState !== WebSocket.OPEN
      ) {
        connectedSocket.close();
        return;
      }
      reconnectAttempt = 0;
    });
    connectedSocket.addEventListener("message", (event) => {
      if (socket !== connectedSocket || stopped) {
        return;
      }
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
        connectedSocket.close();
        return;
      }
      try {
        const decoded = readRealtimeServerEvent(event.data);
        if (instanceId === undefined && decoded.type !== "ready") {
          throw new Error("The realtime server was not ready");
        }
        if (instanceId !== undefined && decoded.type === "ready") {
          throw new Error("The realtime server sent a duplicate handshake");
        }
        receive(decoded);
      } catch {
        connectedSocket.close();
      }
    });
    connectedSocket.addEventListener("close", () => {
      if (socket === connectedSocket) {
        socket = undefined;
        instanceId = undefined;
        discardStateEvents();
        clearDisconnectedStreams();
        rejectPendingCommands(UNKNOWN_OUTCOME_ERROR);
        if (!hasConnected && queuedCommands.length > 0) {
          rejectQueuedCommands(UNKNOWN_OUTCOME_ERROR);
        }
        scheduleReconnect();
      }
    });
    connectedSocket.addEventListener("error", () => {
      if (socket === connectedSocket && !stopped) {
        connectedSocket.close();
      }
    });
  }
  function stateEventKey(event: DeferredStateEvent): string {
    const keys: {
      [Type in DeferredStateEvent["type"]]: (
        matched: Extract<DeferredStateEvent, { readonly type: Type }>,
      ) => string;
    } = {
      runners: (matched) => matched.type,
      session: (matched) => `session:${matched.session.id}`,
      session_compaction_request: (matched) =>
        `${matched.type}:${matched.sessionId}`,
      session_compaction_settled: (matched) =>
        `${matched.type}:${matched.sessionId}`,
      session_questions: (matched) => `session_questions:${matched.sessionId}`,
      sessions: (matched) => matched.type,
      sessions_changed: (matched) => matched.type,
      tool_stream_snapshot: (matched) =>
        `${matched.type}:${matched.sessionId}:${matched.streamId}`,
    };
    return deferredStateEventKey(event, event.type, keys);
  }
  function discardStateEvents(): void {
    stateEventGeneration += 1;
    stateEventFrame = undefined;
    stateEvents.clear();
    // Callers must immediately clear the stream buffer to discard these barriers.
    stateBarriers.clear();
    for (const resolve of stateWaiters.splice(0)) {
      resolve(false);
    }
  }
  function queueStateEvent(event: DeferredStateEvent): void {
    const key = stateEventKey(event);
    stateEvents.delete(key);
    stateEvents.set(key, event);
    const sessionId =
      event.type === "session"
        ? event.session.id
        : "sessionId" in event
          ? event.sessionId
          : undefined;
    if (sessionId !== undefined) {
      const previousBarrier = stateBarriers.get(key);
      if (previousBarrier !== undefined) {
        buffer.releaseBarrier(previousBarrier);
      }
      stateBarriers.set(key, buffer.markBarrier(sessionId));
      invalidateStreamFrame();
    }
    scheduleStateEvent();
  }
  function scheduleStateEvent(): void {
    if (
      stateEventFrame !== undefined ||
      (stateEvents.size === 0 && stateWaiters.length === 0)
    ) {
      return;
    }
    const generation = stateEventGeneration;
    stateEventFrame = requestFrame(() => {
      stateEventFrame = undefined;
      if (generation !== stateEventGeneration || stopped) {
        return;
      }
      const frameStartedAt = now();
      const withinBudget = (): boolean =>
        now() - frameStartedAt < STREAM_PREP_BUDGET_MS;
      while (withinBudget()) {
        const next = stateEvents.entries().next();
        if (next.done) {
          stateWaiters.shift()?.(true);
          break;
        }
        if (!applyDeferredStateEntry(next.value, withinBudget)) break;
      }
      scheduleStateEvent();
      scheduleFrame();
    });
  }
  function applyDeferredStateEntry(
    [key, queued]: readonly [string, DeferredStateEvent],
    withinBudget: () => boolean,
  ): boolean {
    const barrier = stateBarriers.get(key);
    if (barrier !== undefined) {
      const batch = buffer.takeBarrier(
        barrier,
        STREAM_UPDATES_PER_FRAME,
        withinBudget,
      );
      deliverStreamBatch(batch);
      if (batch !== undefined || buffer.barrierPending(barrier)) {
        return false;
      }
    }
    stateEvents.delete(key);
    stateBarriers.delete(key);
    if (barrier !== undefined) buffer.releaseBarrier(barrier);
    deliverDeferredStateEvent(queued);
    return true;
  }
  function deliverDeferredStateEvent(event: DeferredStateEvent): void {
    if (event.type === "tool_stream_snapshot") {
      const snapshot = buffer.applyToolSnapshot(event);
      toolSync.resolve(event);
      deliver(snapshot);
      return;
    }
    if (event.type === "session") {
      if (
        !sessionIsActive(event.session.status) &&
        event.session.status !== "paused"
      ) {
        buffer.clearToolSession(event.session.id);
        toolSync.resolveSession(event.session.id);
      } else {
        syncTools(event.session.id);
      }
    }
    deliver(event);
  }
  function deliver(event: RealtimeClientEvent): void {
    listener(event);
  }
  function deliverStreamBatch(batch: RealtimeStreamBatch | undefined): void {
    if (batch !== undefined) deliver(batch);
  }
  function flushStreamFrame(): void {
    streamFrame = undefined;
    if (!stopped) {
      const frameStartedAt = now();
      deliverStreamBatch(
        buffer.takeNext(
          STREAM_UPDATES_PER_FRAME,
          selected(),
          () => now() - frameStartedAt < STREAM_PREP_BUDGET_MS,
        ),
      );
      scheduleFrame();
    }
  }
  function invalidateStreamFrame(): void {
    generation += 1;
    streamFrame = undefined;
  }
  function scheduleFrame(): void {
    if (streamFrame !== undefined || !buffer.pending || stateEvents.size > 0) {
      return;
    }
    const scheduledGeneration = generation;
    streamFrame = requestFrame(() => {
      if (scheduledGeneration === generation) {
        flushStreamFrame();
      }
    });
  }
  function queueStreamDelta(
    event: Extract<
      RealtimeServerEvent,
      { readonly type: "session_delta" | "tool_stream" }
    >,
  ): void {
    buffer.queue(event);
    const requests = buffer.takeToolResyncRequests();
    syncToolRequests(requests);
    scheduleFrame();
  }
  function syncToolRequests(requests: readonly ToolSyncRequest[]): void {
    const unresolved = toolSync.unresolved(requests);
    for (const [index, request] of unresolved.entries()) {
      if (!sendToolSync(request)) {
        for (const remaining of unresolved.slice(index)) {
          toolSync.remember(remaining);
        }
        return;
      }
      // A sent request stays pending until its matching snapshot arrives.
      toolSync.remember(request);
    }
  }
  function rejectPendingCommands(code: string): void {
    for (const pending of pendingCommands.values()) {
      pending.reject(commandFailure(code));
      commandBytes -= pending.bytes;
    }
    pendingCommands.clear();
  }
  function rejectQueuedCommands(code: string): void {
    for (const queued of queuedCommands) {
      queued.pending.reject(commandFailure(code));
      commandBytes -= queued.pending.bytes;
    }
    queuedCommands = [];
  }
  function settleCommand(
    event: Extract<
      RealtimeServerEvent,
      { readonly type: "command_error" | "command_success" }
    >,
  ): void {
    const pending = pendingCommands.get(event.commandId);
    if (pending === undefined) {
      return;
    }
    pendingCommands.delete(event.commandId);
    commandBytes -= pending.bytes;
    if (event.type === "command_success") {
      pending.resolve(event.result);
    } else {
      const code = normalizedCommandError(event.error);
      pending.reject(commandFailure(code, event.detail));
    }
  }
  function receive(event: RealtimeServerEvent): void {
    if (event.type === "ready") {
      const reconnected = hasConnected;
      const previousInstanceId = lastInstanceId;
      hasConnected = true;
      instanceId = event.instanceId;
      lastInstanceId = event.instanceId;
      const readySocket = socket;
      if (readySocket?.readyState === WebSocket.OPEN) {
        const queued = queuedCommands;
        queuedCommands = [];
        for (const { commandId, pending } of queued) {
          pending.sentInstanceId = event.instanceId;
          pendingCommands.set(commandId, pending);
        }
        const remembered = toolSync.pending();
        toolSync.clear();
        syncToolRequests([
          ...remembered,
          ...buffer.activeToolStreams(),
          ...buffer.takeToolResyncRequests(),
        ]);
      }
      const pendingCommandIds = [...pendingCommands.keys()];
      for (const commandId of pendingCommandIds) {
        const pending = pendingCommands.get(commandId);
        if (pending === undefined) {
          continue;
        }
        if (
          pending.sentInstanceId !== undefined &&
          pending.sentInstanceId !== event.instanceId &&
          previousInstanceId !== event.instanceId
        ) {
          pendingCommands.delete(commandId);
          commandBytes -= pending.bytes;
          pending.reject(commandFailure(UNKNOWN_OUTCOME_ERROR));
          continue;
        }
        const activeSocket = socket;
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
        for (const listener of reconnects) {
          listener();
        }
      }
      deliver(event);
      return;
    }
    if (event.type === "command_success" || event.type === "command_error") {
      settleCommand(event);
      deliver(event);
      return;
    }
    if (
      event.type === "health" ||
      event.type === "tool_settings" ||
      event.type === "development_restart_progress"
    ) {
      deliver(event);
      return;
    }
    if (event.type === "session_delta" || event.type === "tool_stream") {
      queueStreamEvent(event);
      return;
    }
    queueStateEvent(event);
  }
  function queueStreamEvent(
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
      toolSync.resolve(event);
    }
    queueStreamDelta(event);
  }
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }
    const delay =
      RECONNECT_DELAYS[
        Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ] ?? 5_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }
  return {
    command,
    onReconnect,
    start,
    stop,
    syncTools,
    yieldToStateApplication,
  };
}
