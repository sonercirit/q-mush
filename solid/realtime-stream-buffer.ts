import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
  type ToolStreamDeltaFrame,
  type ToolStreamEntry,
  type ToolStreamSnapshotFrame,
} from "../shared/tool-stream.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import { toolSyncKey, type ToolSyncRequest } from "./realtime-client-tool-sync.ts";
import { drainUpdates, retainedToolEntry, updateEpoch, updateFragments, updatePendingBytes } from "./realtime-stream-buffer-helpers.ts";
import {
  MAXIMUM_PENDING_STREAM_BYTES,
  MAXIMUM_PENDING_STREAM_FRAGMENTS,
  MAXIMUM_PENDING_STREAM_KEYS,
} from "./realtime-stream-buffer-limits.ts";
import {
  appendToolDelta,
  emptyChannelChunks,
  initialBufferedToolUpdate,
  materializeModelUpdate,
  materializeToolUpdate,
  modelKey,
  toolKey,
  validatedToolDelta,
  type BufferedStreamUpdate,
  type RealtimeStreamUpdate,
  type RealtimeToolStreamUpdate,
  type SessionStreamDelta,
} from "./realtime-stream-buffer-update.ts";
import { terminalToolState, tombstoneEntry, toolStateSessionId, type RetainedToolState } from "./realtime-stream-tool-state.ts";
export type { RealtimeStreamUpdate, RealtimeToolStreamUpdate };
type SessionDelta = SessionStreamDelta;
type StreamServerEvent = SessionDelta | ToolStreamDeltaFrame;
export interface RealtimeStreamBatch {
  readonly type: "stream_batch";
  readonly updates: readonly RealtimeStreamUpdate[];
}
export type RealtimeClientEvent = Exclude<RealtimeServerEvent, StreamServerEvent> | RealtimeStreamBatch;
export interface RealtimeStreamBarrier {
  readonly epoch: number;
  readonly sessionId: string;
}
export interface RealtimeStreamBuffer {
  readonly pending: boolean;
  clear(): void;
  clearPending(): void;
  markBarrier(sessionId: string): RealtimeStreamBarrier;
  releaseBarrier(barrier: RealtimeStreamBarrier): void;
  activeToolStreams(sessionId?: string): readonly ToolSyncRequest[];
  takeToolResyncRequests(): readonly ToolSyncRequest[];
  clearToolSession(sessionId: string): void;
  queue(event: StreamServerEvent): void;
  takeNext(maximumUpdates?: number, selectedSessionId?: string, withinBudget?: () => boolean): RealtimeStreamBatch | undefined;
  takeBarrier(barrier: RealtimeStreamBarrier, maximumUpdates?: number, withinBudget?: () => boolean): RealtimeStreamBatch | undefined;
  barrierPending(barrier: RealtimeStreamBarrier): boolean;
  applyToolSnapshot(snapshot: ToolStreamSnapshotFrame): ToolStreamSnapshotFrame;
}
export function createRealtimeStreamBuffer(): RealtimeStreamBuffer {
  let isSelectedTurn = true;
  let pendingBytes = 0;
  let pendingFragments = 0;
  const pendingBySession = new Map<string, Map<string, BufferedStreamUpdate>>();
  const pendingOrder = new Map<string, string>();
  const pendingToolKeys = new Map<string, string>();
  const resyncRequests = new Map<string, { sessionId: string; streamId: string }>();
  let lastSelectedSessionId: string | undefined;
  const sessionEpochs = new Map<string, number>();
  const barrierCountsBySession = new Map<string, number>();
  const retainedToolStates = new Map<string, RetainedToolState>();
  function hasPending(): boolean {
    return pendingOrder.size > 0;
  }
  function clear(): void {
    clearPending();
    retainedToolStates.clear();
    resyncRequests.clear();
    isSelectedTurn = true;
    lastSelectedSessionId = undefined;
  }
  // Callers must discard every outstanding barrier before clearing pending data.
  function clearPending(): void {
    for (const pending of pendingBySession.values()) {
      for (const update of pending.values()) {
        if (update.kind === "tool") {
          requestToolResync(update.value.entry);
        }
      }
    }
    pendingBytes = 0;
    pendingFragments = 0;
    pendingBySession.clear();
    pendingOrder.clear();
    pendingToolKeys.clear();
    sessionEpochs.clear();
    barrierCountsBySession.clear();
  }
  function markBarrier(sessionId: string): RealtimeStreamBarrier {
    const epoch = sessionEpoch(sessionId);
    sessionEpochs.set(sessionId, epoch + 1);
    barrierCountsBySession.set(sessionId, (barrierCountsBySession.get(sessionId) ?? 0) + 1);
    return { epoch, sessionId };
  }
  function releaseBarrier(barrier: RealtimeStreamBarrier): void {
    const count = barrierCountsBySession.get(barrier.sessionId);
    if (count === undefined) return;
    if (count > 1) {
      barrierCountsBySession.set(barrier.sessionId, count - 1);
      return;
    }
    barrierCountsBySession.delete(barrier.sessionId);
    deleteUnusedEpoch(barrier.sessionId);
  }
  function deleteUnusedEpoch(sessionId: string): void {
    // An epoch may be reused only when no barrier or queued update can observe it.
    if (!barrierCountsBySession.has(sessionId) && !pendingBySession.has(sessionId)) {
      sessionEpochs.delete(sessionId);
    }
  }
  function sessionEpoch(sessionId: string): number {
    return sessionEpochs.get(sessionId) ?? 0;
  }
  function pendingSession(sessionId: string, create = false): Map<string, BufferedStreamUpdate> | undefined {
    const current = pendingBySession.get(sessionId);
    if (current !== undefined || !create) return current;
    const pending = new Map<string, BufferedStreamUpdate>();
    pendingBySession.set(sessionId, pending);
    return pending;
  }
  function removePending(sessionId: string, key: string): BufferedStreamUpdate | undefined {
    const pending = pendingSession(sessionId);
    const update = pending?.get(key);
    if (pending === undefined || update === undefined) return undefined;
    pending.delete(key);
    pendingOrder.delete(key);
    if (update.kind === "tool" && pendingToolKeys.get(toolKey(update.value.entry)) === key) {
      pendingToolKeys.delete(toolKey(update.value.entry));
    }
    pendingBytes -= updatePendingBytes(update);
    pendingFragments -= updateFragments(update);
    if (pending.size === 0) {
      pendingBySession.delete(sessionId);
      deleteUnusedEpoch(sessionId);
    }
    return update;
  }
  function deletePending(sessionId: string, include: (update: BufferedStreamUpdate) => boolean): void {
    const pending = pendingSession(sessionId);
    if (pending === undefined) return;
    for (const [key, update] of pending) {
      if (include(update)) removePending(sessionId, key);
    }
  }
  function deleteToolStates(include: (state: RetainedToolState) => boolean): void {
    for (const [key, state] of retainedToolStates) {
      if (include(state)) retainedToolStates.delete(key);
    }
  }
  function activeToolStreams(sessionId?: string): readonly ToolSyncRequest[] {
    const streams = new Map<string, { sessionId: string; streamId: string }>();
    for (const state of retainedToolStates.values()) {
      if (state.kind !== "active" || (sessionId !== undefined && state.entry.sessionId !== sessionId)) {
        continue;
      }
      const value = {
        sessionId: state.entry.sessionId,
        streamId: state.entry.streamId,
      };
      streams.set(toolSyncKey(value), value);
    }
    return [...streams.values()];
  }
  function takeToolResyncRequests(): readonly ToolSyncRequest[] {
    const requests = [...resyncRequests.values()];
    resyncRequests.clear();
    return requests;
  }
  function clearToolSession(sessionId: string): void {
    deletePending(sessionId, (update) => update.kind === "tool");
    deleteToolStates((state) => (state.kind === "active" ? state.entry.sessionId === sessionId : state.sessionId === sessionId));
  }
  function queue(event: StreamServerEvent): void {
    if (event.type === "session_delta") {
      queueSessionDelta(event);
    } else {
      queueToolUpdate(event);
    }
  }
  function compactPending(update: BufferedStreamUpdate): void {
    const previousFragments = updateFragments(update);
    if (previousFragments <= 1) return;
    if (update.kind === "model") {
      update.value.content = [update.value.content.join("")];
      update.value.thinking = [update.value.thinking.join("")];
      update.value.fragments = 1;
    } else {
      update.value.entry = materializeToolUpdate(update.value);
      update.value.chunks = emptyChannelChunks();
      update.value.fragments = 0;
    }
    pendingFragments -= previousFragments - updateFragments(update);
  }
  function oldestEvictable(protectedKey: string | undefined): string | undefined {
    for (const key of pendingOrder.keys()) {
      if (key !== protectedKey) return key;
    }
    return undefined;
  }
  function evictPending(key: string): void {
    const sessionId = pendingOrder.get(key);
    if (sessionId === undefined) return;
    const update = removePending(sessionId, key);
    if (update?.kind === "tool") {
      requestToolResync(update.value.entry);
      commitToolState(materializeToolUpdate(update.value), update.value.terminal);
    }
  }
  function hasCapacity(bytes: number, fragments: number, additionalKey: boolean): boolean {
    return (
      bytes <= MAXIMUM_PENDING_STREAM_BYTES - pendingBytes &&
      fragments <= MAXIMUM_PENDING_STREAM_FRAGMENTS - pendingFragments &&
      (!additionalKey || pendingOrder.size < MAXIMUM_PENDING_STREAM_KEYS)
    );
  }
  function makeRoom(bytes: number, fragments: number, additionalKey: boolean, protectedKey?: string): boolean {
    if (protectedKey !== undefined && !hasCapacity(bytes, fragments, additionalKey)) {
      const protectedSessionId = pendingOrder.get(protectedKey);
      const protectedUpdate = protectedSessionId === undefined ? undefined : pendingSession(protectedSessionId)?.get(protectedKey);
      if (protectedUpdate !== undefined) compactPending(protectedUpdate);
    }
    while (!hasCapacity(bytes, fragments, additionalKey)) {
      const oldest = oldestEvictable(protectedKey);
      if (oldest === undefined) return false;
      const oldestSessionId = pendingOrder.get(oldest);
      const oldestUpdate = oldestSessionId === undefined ? undefined : pendingSession(oldestSessionId)?.get(oldest);
      if (oldestUpdate !== undefined) compactPending(oldestUpdate);
      if (hasCapacity(bytes, fragments, additionalKey)) return true;
      evictPending(oldest);
    }
    return true;
  }
  function storePending(sessionId: string, key: string, update: BufferedStreamUpdate): void {
    const pending = pendingSession(sessionId, true);
    pending?.set(key, update);
    pendingOrder.set(key, sessionId);
    if (update.kind === "tool") {
      pendingToolKeys.set(toolKey(update.value.entry), key);
    }
    pendingBytes += updatePendingBytes(update);
    pendingFragments += updateFragments(update);
  }
  function queueSessionDelta(event: SessionDelta): void {
    let epoch = sessionEpoch(event.sessionId);
    let key = modelKey(event, epoch);
    if (event.reset === true) {
      deletePending(event.sessionId, (update) => update.kind === "model" && update.value.epoch === epoch);
    }
    const previous = pendingSession(event.sessionId)?.get(key);
    const bytes = utf8ByteLength(event.content) + utf8ByteLength(event.thinking);
    if (!makeRoom(bytes, 1, previous === undefined, key)) return;
    if (previous?.kind === "model") {
      previous.value.content.push(event.content);
      previous.value.thinking.push(event.thinking);
      previous.value.pendingBytes += bytes;
      previous.value.fragments += 1;
      pendingBytes += bytes;
      pendingFragments += 1;
      return;
    }
    epoch = sessionEpoch(event.sessionId);
    key = modelKey(event, epoch);
    storePending(event.sessionId, key, {
      kind: "model",
      value: {
        content: [event.content],
        epoch,
        event,
        fragments: 1,
        pendingBytes: bytes,
        thinking: [event.thinking],
      },
    });
  }
  function currentToolEntry(key: string): ToolStreamEntry | undefined {
    const retained = retainedToolStates.get(key);
    return retained?.kind === "active" ? retained.entry : retained === undefined ? undefined : tombstoneEntry(retained);
  }
  function pendingToolEntry(sessionId: string, retainedKey: string): ToolStreamEntry | undefined {
    const key = pendingToolKeys.get(retainedKey);
    const update = key === undefined ? undefined : pendingSession(sessionId)?.get(key);
    return update?.kind === "tool" ? materializeToolUpdate(update.value) : undefined;
  }
  function requestToolResync(request: ToolSyncRequest): void {
    const value = {
      sessionId: request.sessionId,
      streamId: request.streamId,
    };
    resyncRequests.set(toolSyncKey(value), value);
  }
  function queueToolUpdate(event: ToolStreamDeltaFrame): void {
    let epoch = sessionEpoch(event.sessionId);
    let key = toolKey(event, epoch);
    const pending = pendingSession(event.sessionId);
    const found = pending?.get(key);
    const buffered = found?.kind === "tool" ? found.value : undefined;
    const current = buffered?.entry ?? pendingToolEntry(event.sessionId, toolKey(event)) ?? currentToolEntry(toolKey(event));
    let result = validatedToolDelta(current, event);
    if (!result.accepted) {
      if (result.reason === "initial" || result.reason === "gap") {
        requestToolResync(event);
      }
      return;
    }
    const contentBytes = utf8ByteLength(event.content ?? "");
    const fragments = event.content === undefined ? 0 : 1;
    if (!makeRoom(contentBytes, fragments, buffered === undefined, key)) {
      requestToolResync(event);
      return;
    }
    if (buffered !== undefined && buffered.entry !== current) {
      result = validatedToolDelta(buffered.entry, event);
      if (!result.accepted) {
        requestToolResync(event);
        return;
      }
    }
    if (buffered === undefined) {
      epoch = sessionEpoch(event.sessionId);
      key = toolKey(event, epoch);
    }
    const next = buffered ?? initialBufferedToolUpdate(result.entry, epoch);
    if (!appendToolDelta(next, event, result.entry)) return;
    if (buffered === undefined) {
      storePending(event.sessionId, key, { kind: "tool", value: next });
    } else {
      pendingBytes += contentBytes;
      pendingFragments += fragments;
    }
  }
  function backgroundSession(selectedSessionId: string | undefined): string | undefined {
    for (const sessionId of pendingBySession.keys()) {
      if (sessionId !== selectedSessionId) return sessionId;
    }
    return undefined;
  }
  function takeFirst(sessionId: string, rotate: boolean): RealtimeStreamUpdate | undefined {
    const pending = pendingBySession.get(sessionId);
    const next = pending?.entries().next();
    if (pending === undefined || next?.done !== false) return undefined;
    const [key] = next.value;
    const update = removePending(sessionId, key);
    const remaining = pendingBySession.get(sessionId);
    if (rotate && remaining !== undefined) {
      pendingBySession.delete(sessionId);
      pendingBySession.set(sessionId, remaining);
    }
    return update === undefined ? undefined : materialize(update);
  }
  function takeNext(
    maximumUpdates = 1,
    selectedSessionId?: string,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    if (selectedSessionId !== lastSelectedSessionId) {
      isSelectedTurn = true;
      lastSelectedSessionId = selectedSessionId;
    }
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const backgroundSessionId = backgroundSession(selectedSessionId);
      const preferredSessionId = isSelectedTurn ? selectedSessionId : backgroundSessionId;
      const fallbackSessionId = isSelectedTurn ? backgroundSessionId : selectedSessionId;
      const sessionId =
        preferredSessionId !== undefined && pendingBySession.has(preferredSessionId) ? preferredSessionId : fallbackSessionId;
      if (sessionId === undefined) return undefined;
      const update = takeFirst(sessionId, sessionId !== selectedSessionId);
      if (update === undefined) return undefined;
      isSelectedTurn = !isSelectedTurn;
      return update;
    });
  }
  function takeBarrier(
    barrier: RealtimeStreamBarrier,
    maximumUpdates = 1,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const pending = pendingBySession.get(barrier.sessionId);
      const first = pending?.values().next();
      if (pending === undefined || first?.done !== false || updateEpoch(first.value) > barrier.epoch) {
        return undefined;
      }
      return takeFirst(barrier.sessionId, false);
    });
  }
  function barrierPending(barrier: RealtimeStreamBarrier): boolean {
    const first = pendingBySession.get(barrier.sessionId)?.values().next();
    return first?.done === false && updateEpoch(first.value) <= barrier.epoch;
  }
  function deleteOldestToolState(sessionId?: string): void {
    let oldest: string | undefined;
    let oldestTerminal: string | undefined;
    for (const [key, state] of retainedToolStates) {
      if (sessionId !== undefined && toolStateSessionId(state) !== sessionId) {
        continue;
      }
      oldest ??= key;
      if (state.kind === "terminal") {
        oldestTerminal = key;
        break;
      }
    }
    const key = oldestTerminal ?? oldest;
    if (key !== undefined) retainedToolStates.delete(key);
  }
  function trimToolStates(sessionId: string): void {
    let sessionEntries = 0;
    for (const state of retainedToolStates.values()) {
      if (toolStateSessionId(state) === sessionId) sessionEntries += 1;
    }
    while (sessionEntries > MAXIMUM_TOOL_STREAMS_PER_SESSION) {
      deleteOldestToolState(sessionId);
      sessionEntries -= 1;
    }
    while (retainedToolStates.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      deleteOldestToolState();
    }
  }
  function commitToolState(entry: ToolStreamEntry, terminal: boolean): void {
    const key = toolKey(entry);
    retainedToolStates.delete(key);
    retainedToolStates.set(key, terminal ? terminalToolState(entry) : { entry, kind: "active" });
    trimToolStates(entry.sessionId);
  }
  function materialize(update: BufferedStreamUpdate): RealtimeStreamUpdate {
    if (update.kind === "model") {
      return materializeModelUpdate(update.value);
    }
    const entry = materializeToolUpdate(update.value);
    commitToolState(entry, update.value.terminal);
    return {
      entry,
      terminal: update.value.terminal,
      type: "tool_update",
    };
  }
  function applyToolSnapshot(snapshot: ToolStreamSnapshotFrame): ToolStreamSnapshotFrame {
    const retained = new Map<string, ToolStreamEntry>();
    for (const received of snapshot.streams) {
      const key = toolKey(received);
      const entry = retainedToolEntry(retainedToolStates.get(key), received);
      if (entry !== undefined) retained.set(key, entry);
    }
    deleteToolStates(
      (state) => state.kind === "active" && state.entry.sessionId === snapshot.sessionId && state.entry.streamId === snapshot.streamId,
    );
    for (const [key, entry] of retained) {
      retainedToolStates.set(key, { entry, kind: "active" });
      trimToolStates(entry.sessionId);
    }
    return { ...snapshot, streams: [...retained.values()] };
  }

  return {
    get pending() {
      return hasPending();
    },
    activeToolStreams,
    applyToolSnapshot,
    barrierPending,
    clear,
    clearPending,
    clearToolSession,
    markBarrier,
    queue,
    releaseBarrier,
    takeBarrier,
    takeNext,
    takeToolResyncRequests,
  };
}
