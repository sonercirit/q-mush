import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
  type ToolStreamDeltaFrame,
  type ToolStreamEntry,
  type ToolStreamSnapshotFrame,
} from "../shared/tool-stream.ts";
import { USER_REALTIME_MAX_PAYLOAD_LENGTH } from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
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
import {
  terminalToolState,
  tombstoneEntry,
  toolStateSessionId,
  type RetainedToolState,
} from "./realtime-stream-tool-state.ts";
export type { RealtimeStreamUpdate, RealtimeToolStreamUpdate };
type SessionDelta = SessionStreamDelta;
type StreamServerEvent = SessionDelta | ToolStreamDeltaFrame;
export interface RealtimeStreamBatch {
  readonly type: "stream_batch";
  readonly updates: readonly RealtimeStreamUpdate[];
}
export type RealtimeClientEvent =
  Exclude<RealtimeServerEvent, StreamServerEvent> | RealtimeStreamBatch;
export interface RealtimeStreamBarrier {
  readonly epoch: number;
  readonly sessionId: string;
}
interface ToolStreamRequest {
  readonly sessionId: string;
  readonly streamId: string;
}
const MAXIMUM_PENDING_STREAM_BYTES = USER_REALTIME_MAX_PAYLOAD_LENGTH - 1;
const MAXIMUM_PENDING_STREAM_FRAGMENTS = MAXIMUM_TOOL_STREAMS_PER_USER;
const MAXIMUM_PENDING_STREAM_KEYS = MAXIMUM_TOOL_STREAMS_PER_USER;
function streamBatch(
  updates: readonly RealtimeStreamUpdate[],
): RealtimeStreamBatch | undefined {
  return updates.length === 0 ? undefined : { type: "stream_batch", updates };
}
function updateEpoch(update: BufferedStreamUpdate): number {
  return update.value.epoch;
}
function updatePendingBytes(update: BufferedStreamUpdate): number {
  return update.value.pendingBytes;
}
function updateFragments(update: BufferedStreamUpdate): number {
  return update.value.fragments;
}
function pendingWithinLimit(
  updates: readonly RealtimeStreamUpdate[],
  maximumUpdates: number,
  withinBudget: () => boolean,
): boolean {
  return (
    updates.length < maximumUpdates && (updates.length === 0 || withinBudget())
  );
}
function drainUpdates(
  maximumUpdates: number,
  withinBudget: () => boolean,
  take: () => RealtimeStreamUpdate | undefined,
): RealtimeStreamBatch | undefined {
  const updates: RealtimeStreamUpdate[] = [];
  while (pendingWithinLimit(updates, maximumUpdates, withinBudget)) {
    const update = take();
    if (update === undefined) break;
    updates.push(update);
  }
  return streamBatch(updates);
}
function retainedToolEntry(
  local: RetainedToolState | undefined,
  received: ToolStreamEntry,
): ToolStreamEntry | undefined {
  if (local?.kind === "terminal") return undefined;
  if (local === undefined) return received;
  return local.entry.sequence >= received.sequence ? local.entry : received;
}
export class RealtimeStreamBuffer {
  #selectedTurn = true;
  #bytes = 0;
  #fragments = 0;
  readonly #pending = new Map<string, Map<string, BufferedStreamUpdate>>();
  readonly #order = new Map<string, string>();
  readonly #toolKeys = new Map<string, string>();
  readonly #resync = new Map<string, { sessionId: string; streamId: string }>();
  #selectedId: string | undefined;
  readonly #epochs = new Map<string, number>();
  readonly #toolStates = new Map<string, RetainedToolState>();
  get pending(): boolean {
    return this.#order.size > 0;
  }
  clear(): void {
    this.clearPending();
    this.#toolStates.clear();
    this.#resync.clear();
    this.#selectedTurn = true;
    this.#selectedId = undefined;
  }
  clearPending(): void {
    for (const pending of this.#pending.values()) {
      for (const update of pending.values()) {
        if (update.kind === "tool") {
          this.#requestToolResync(update.value.entry);
        }
      }
    }
    this.#bytes = 0;
    this.#fragments = 0;
    this.#pending.clear();
    this.#order.clear();
    this.#toolKeys.clear();
    this.#epochs.clear();
  }
  markBarrier(sessionId: string): RealtimeStreamBarrier {
    const epoch = this.#sessionEpoch(sessionId);
    this.#epochs.set(sessionId, epoch + 1);
    return { epoch, sessionId };
  }
  #sessionEpoch(sessionId: string): number {
    return this.#epochs.get(sessionId) ?? 0;
  }
  #pendingSession(
    sessionId: string,
    create = false,
  ): Map<string, BufferedStreamUpdate> | undefined {
    const current = this.#pending.get(sessionId);
    if (current !== undefined || !create) return current;
    const pending = new Map<string, BufferedStreamUpdate>();
    this.#pending.set(sessionId, pending);
    return pending;
  }
  #removePending(
    sessionId: string,
    key: string,
  ): BufferedStreamUpdate | undefined {
    const pending = this.#pendingSession(sessionId);
    const update = pending?.get(key);
    if (pending === undefined || update === undefined) return undefined;
    pending.delete(key);
    this.#order.delete(key);
    if (
      update.kind === "tool" &&
      this.#toolKeys.get(toolKey(update.value.entry)) === key
    ) {
      this.#toolKeys.delete(toolKey(update.value.entry));
    }
    this.#bytes -= updatePendingBytes(update);
    this.#fragments -= updateFragments(update);
    if (pending.size === 0) this.#pending.delete(sessionId);
    return update;
  }
  #deletePending(
    sessionId: string,
    include: (update: BufferedStreamUpdate) => boolean,
  ): void {
    const pending = this.#pendingSession(sessionId);
    if (pending === undefined) return;
    for (const [key, update] of pending) {
      if (include(update)) this.#removePending(sessionId, key);
    }
  }
  #deleteToolStates(include: (state: RetainedToolState) => boolean): void {
    for (const [key, state] of this.#toolStates) {
      if (include(state)) this.#toolStates.delete(key);
    }
  }
  activeToolStreams(sessionId?: string): readonly ToolStreamRequest[] {
    const streams = new Map<string, { sessionId: string; streamId: string }>();
    for (const state of this.#toolStates.values()) {
      if (
        state.kind !== "active" ||
        (sessionId !== undefined && state.entry.sessionId !== sessionId)
      ) {
        continue;
      }
      const value = {
        sessionId: state.entry.sessionId,
        streamId: state.entry.streamId,
      };
      const streamKey = JSON.stringify([value.sessionId, value.streamId]);
      streams.set(streamKey, value);
    }
    return [...streams.values()];
  }
  takeToolResyncRequests(): readonly ToolStreamRequest[] {
    const requests = [...this.#resync.values()];
    this.#resync.clear();
    return requests;
  }
  clearToolSession(sessionId: string): void {
    this.#deletePending(sessionId, (update) => update.kind === "tool");
    this.#deleteToolStates((state) =>
      state.kind === "active"
        ? state.entry.sessionId === sessionId
        : state.sessionId === sessionId,
    );
  }
  queue(event: StreamServerEvent): void {
    if (event.type === "session_delta") {
      this.#queueSessionDelta(event);
    } else {
      this.#queueToolUpdate(event);
    }
  }
  #compactPending(update: BufferedStreamUpdate): void {
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
    this.#fragments -= previousFragments - updateFragments(update);
  }
  #oldestEvictable(protectedKey: string | undefined): string | undefined {
    for (const key of this.#order.keys()) {
      if (key !== protectedKey) return key;
    }
    return undefined;
  }
  #evictPending(key: string): void {
    const sessionId = this.#order.get(key);
    if (sessionId === undefined) return;
    const update = this.#removePending(sessionId, key);
    if (update?.kind === "tool") {
      this.#commitToolState(
        materializeToolUpdate(update.value),
        update.value.terminal,
      );
    }
  }
  #hasCapacity(
    bytes: number,
    fragments: number,
    additionalKey: boolean,
  ): boolean {
    return (
      bytes <= MAXIMUM_PENDING_STREAM_BYTES - this.#bytes &&
      fragments <= MAXIMUM_PENDING_STREAM_FRAGMENTS - this.#fragments &&
      (!additionalKey || this.#order.size < MAXIMUM_PENDING_STREAM_KEYS)
    );
  }
  #makeRoom(
    bytes: number,
    fragments: number,
    additionalKey: boolean,
    protectedKey?: string,
  ): boolean {
    if (
      protectedKey !== undefined &&
      !this.#hasCapacity(bytes, fragments, additionalKey)
    ) {
      const protectedSessionId = this.#order.get(protectedKey);
      const protectedUpdate =
        protectedSessionId === undefined
          ? undefined
          : this.#pendingSession(protectedSessionId)?.get(protectedKey);
      if (protectedUpdate !== undefined) this.#compactPending(protectedUpdate);
    }
    while (!this.#hasCapacity(bytes, fragments, additionalKey)) {
      const oldest = this.#oldestEvictable(protectedKey);
      if (oldest === undefined) return false;
      this.#evictPending(oldest);
    }
    return true;
  }
  #storePending(
    sessionId: string,
    key: string,
    update: BufferedStreamUpdate,
  ): void {
    const pending = this.#pendingSession(sessionId, true);
    pending?.set(key, update);
    this.#order.set(key, sessionId);
    if (update.kind === "tool") {
      this.#toolKeys.set(toolKey(update.value.entry), key);
    }
    this.#bytes += updatePendingBytes(update);
    this.#fragments += updateFragments(update);
  }
  #queueSessionDelta(event: SessionDelta): void {
    const epoch = this.#sessionEpoch(event.sessionId);
    const key = modelKey(event, epoch);
    if (event.reset === true) {
      this.#deletePending(
        event.sessionId,
        (update) => update.kind === "model" && update.value.epoch === epoch,
      );
    }
    const previous = this.#pendingSession(event.sessionId)?.get(key);
    const bytes =
      utf8ByteLength(event.content) + utf8ByteLength(event.thinking);
    if (!this.#makeRoom(bytes, 1, previous === undefined, key)) {
      return;
    }
    if (previous?.kind === "model") {
      previous.value.content.push(event.content);
      previous.value.thinking.push(event.thinking);
      previous.value.pendingBytes += bytes;
      previous.value.fragments += 1;
      this.#bytes += bytes;
      this.#fragments += 1;
      return;
    }
    this.#storePending(event.sessionId, key, {
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
  #currentToolEntry(key: string): ToolStreamEntry | undefined {
    const retained = this.#toolStates.get(key);
    return retained?.kind === "active"
      ? retained.entry
      : retained === undefined
        ? undefined
        : tombstoneEntry(retained);
  }
  #pendingToolEntry(
    sessionId: string,
    retainedKey: string,
  ): ToolStreamEntry | undefined {
    const key = this.#toolKeys.get(retainedKey);
    const update =
      key === undefined ? undefined : this.#pendingSession(sessionId)?.get(key);
    return update?.kind === "tool"
      ? materializeToolUpdate(update.value)
      : undefined;
  }
  #requestToolResync(request: ToolStreamRequest): void {
    const value = {
      sessionId: request.sessionId,
      streamId: request.streamId,
    };
    this.#resync.set(JSON.stringify([value.sessionId, value.streamId]), value);
  }
  #queueToolUpdate(event: ToolStreamDeltaFrame): void {
    const epoch = this.#sessionEpoch(event.sessionId);
    const key = toolKey(event, epoch);
    const pending = this.#pendingSession(event.sessionId);
    const found = pending?.get(key);
    const buffered = found?.kind === "tool" ? found.value : undefined;
    const retainedKey = toolKey(event);
    const current =
      buffered?.entry ??
      this.#pendingToolEntry(event.sessionId, retainedKey) ??
      this.#currentToolEntry(retainedKey);
    const result = validatedToolDelta(current, event);
    if (!result.accepted) {
      if (result.reason === "initial" || result.reason === "gap") {
        this.#requestToolResync(event);
      }
      return;
    }
    const contentBytes =
      event.content === undefined ? 0 : utf8ByteLength(event.content);
    const fragments = event.content === undefined ? 0 : 1;
    if (!this.#makeRoom(contentBytes, fragments, buffered === undefined, key)) {
      this.#requestToolResync(event);
      return;
    }
    const next = buffered ?? initialBufferedToolUpdate(result.entry, epoch);
    if (appendToolDelta(next, event, result.entry) === undefined) return;
    if (buffered === undefined) {
      this.#storePending(event.sessionId, key, { kind: "tool", value: next });
    } else {
      this.#bytes += contentBytes;
      this.#fragments += fragments;
    }
  }
  #backgroundSession(
    selectedSessionId: string | undefined,
  ): string | undefined {
    for (const sessionId of this.#pending.keys()) {
      if (sessionId !== selectedSessionId) return sessionId;
    }
    return undefined;
  }
  #takeFirst(
    sessionId: string,
    rotate: boolean,
  ): RealtimeStreamUpdate | undefined {
    const pending = this.#pending.get(sessionId);
    const next = pending?.entries().next();
    if (pending === undefined || next?.done !== false) return undefined;
    const [key] = next.value;
    const update = this.#removePending(sessionId, key);
    const remaining = this.#pending.get(sessionId);
    if (rotate && remaining !== undefined) {
      this.#pending.delete(sessionId);
      this.#pending.set(sessionId, remaining);
    }
    return update === undefined ? undefined : this.#materialize(update);
  }
  takeNext(
    maximumUpdates = 1,
    selectedSessionId?: string,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    if (selectedSessionId !== this.#selectedId) {
      this.#selectedTurn = true;
      this.#selectedId = selectedSessionId;
    }
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const backgroundSessionId = this.#backgroundSession(selectedSessionId);
      const preferredSessionId = this.#selectedTurn
        ? selectedSessionId
        : backgroundSessionId;
      const fallbackSessionId = this.#selectedTurn
        ? backgroundSessionId
        : selectedSessionId;
      const sessionId =
        preferredSessionId !== undefined &&
        this.#pending.has(preferredSessionId)
          ? preferredSessionId
          : fallbackSessionId;
      if (sessionId === undefined) return undefined;
      const update = this.#takeFirst(
        sessionId,
        sessionId !== selectedSessionId,
      );
      if (update === undefined) return undefined;
      this.#selectedTurn = !this.#selectedTurn;
      return update;
    });
  }
  takeBarrier(
    barrier: RealtimeStreamBarrier,
    maximumUpdates = 1,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const pending = this.#pending.get(barrier.sessionId);
      // A session Map preserves insertion order, and markBarrier advances the
      // epoch before later updates are inserted (see markBarrier above). Thus
      // the first entry has its lowest epoch.
      const first = pending?.values().next();
      if (
        pending === undefined ||
        first?.done !== false ||
        updateEpoch(first.value) > barrier.epoch
      ) {
        return undefined;
      }
      return this.#takeFirst(barrier.sessionId, false);
    });
  }
  barrierPending(barrier: RealtimeStreamBarrier): boolean {
    const first = this.#pending.get(barrier.sessionId)?.values().next();
    return first?.done === false && updateEpoch(first.value) <= barrier.epoch;
  }
  #deleteOldestToolState(sessionId?: string): void {
    let oldest: string | undefined;
    let oldestTerminal: string | undefined;
    for (const [key, state] of this.#toolStates) {
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
    if (key !== undefined) this.#toolStates.delete(key);
  }
  #trimToolStates(sessionId: string): void {
    let sessionEntries = 0;
    for (const state of this.#toolStates.values()) {
      if (toolStateSessionId(state) === sessionId) sessionEntries += 1;
    }
    while (sessionEntries > MAXIMUM_TOOL_STREAMS_PER_SESSION) {
      this.#deleteOldestToolState(sessionId);
      sessionEntries -= 1;
    }
    while (this.#toolStates.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      this.#deleteOldestToolState();
    }
  }
  #commitToolState(entry: ToolStreamEntry, terminal: boolean): void {
    const key = toolKey(entry);
    this.#toolStates.delete(key);
    this.#toolStates.set(
      key,
      terminal ? terminalToolState(entry) : { entry, kind: "active" },
    );
    this.#trimToolStates(entry.sessionId);
  }
  #materialize(update: BufferedStreamUpdate): RealtimeStreamUpdate {
    if (update.kind === "model") {
      return materializeModelUpdate(update.value);
    }
    const entry = materializeToolUpdate(update.value);
    this.#commitToolState(entry, update.value.terminal);
    return {
      entry,
      terminal: update.value.terminal,
      type: "tool_update",
    };
  }
  applyToolSnapshot(
    snapshot: ToolStreamSnapshotFrame,
  ): ToolStreamSnapshotFrame {
    const retained = new Map<string, ToolStreamEntry>();
    for (const received of snapshot.streams) {
      const key = toolKey(received);
      const entry = retainedToolEntry(this.#toolStates.get(key), received);
      if (entry !== undefined) retained.set(key, entry);
    }
    this.#deleteToolStates(
      (state) =>
        state.kind === "active" &&
        state.entry.sessionId === snapshot.sessionId &&
        state.entry.streamId === snapshot.streamId,
    );
    for (const [key, entry] of retained) {
      this.#toolStates.set(key, { entry, kind: "active" });
      this.#trimToolStates(entry.sessionId);
    }
    return { ...snapshot, streams: [...retained.values()] };
  }
}
