import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
  type ToolStreamDeltaFrame,
  type ToolStreamEntry,
  type ToolStreamSnapshotFrame,
  type ToolStreamTerminalState,
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

interface ActiveToolState {
  readonly entry: ToolStreamEntry;
  readonly kind: "active";
}

interface TerminalToolState {
  readonly callId: string;
  readonly index: number;
  readonly kind: "terminal";
  readonly sequence: number;
  readonly sessionId: string;
  readonly state: ToolStreamTerminalState;
  readonly streamId: string;
}

type RetainedToolState = ActiveToolState | TerminalToolState;

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

function toolStateSessionId(state: RetainedToolState): string {
  return state.kind === "active" ? state.entry.sessionId : state.sessionId;
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

function terminalToolState(entry: ToolStreamEntry): TerminalToolState {
  if (entry.state === "preparing" || entry.state === "running") {
    throw new TypeError("A tool tombstone must be terminal");
  }
  return {
    callId: entry.callId,
    index: entry.index,
    kind: "terminal",
    sequence: entry.sequence,
    sessionId: entry.sessionId,
    state: entry.state,
    streamId: entry.streamId,
  };
}

function tombstoneEntry(tombstone: TerminalToolState): ToolStreamEntry {
  return {
    arguments: "",
    callId: tombstone.callId,
    index: tombstone.index,
    name: "",
    sequence: tombstone.sequence,
    sessionId: tombstone.sessionId,
    state: tombstone.state,
    stderr: "",
    stdout: "",
    streamId: tombstone.streamId,
  };
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
  #nextSelectedTurn = true;
  #pendingBytes = 0;
  #pendingFragments = 0;
  readonly #pendingBySession = new Map<
    string,
    Map<string, BufferedStreamUpdate>
  >();
  readonly #pendingOrder = new Map<string, string>();
  #selectedSessionId: string | undefined;
  readonly #sessionEpochs = new Map<string, number>();
  readonly #toolStates = new Map<string, RetainedToolState>();

  get pending(): boolean {
    return this.#pendingOrder.size > 0;
  }

  clear(): void {
    this.clearPending();
    this.#toolStates.clear();
  }

  clearPending(): void {
    this.#pendingBytes = 0;
    this.#pendingFragments = 0;
    this.#pendingBySession.clear();
    this.#pendingOrder.clear();
    this.#sessionEpochs.clear();
  }

  markBarrier(sessionId: string): RealtimeStreamBarrier {
    const epoch = this.#sessionEpoch(sessionId);
    this.#sessionEpochs.set(sessionId, epoch + 1);
    return { epoch, sessionId };
  }

  #sessionEpoch(sessionId: string): number {
    return this.#sessionEpochs.get(sessionId) ?? 0;
  }

  #pendingSession(
    sessionId: string,
    create = false,
  ): Map<string, BufferedStreamUpdate> | undefined {
    const current = this.#pendingBySession.get(sessionId);
    if (current !== undefined || !create) return current;
    const pending = new Map<string, BufferedStreamUpdate>();
    this.#pendingBySession.set(sessionId, pending);
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
    this.#pendingOrder.delete(key);
    this.#pendingBytes -= updatePendingBytes(update);
    this.#pendingFragments -= updateFragments(update);
    if (pending.size === 0) this.#pendingBySession.delete(sessionId);
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

  activeToolStreams(sessionId?: string): readonly Readonly<{
    sessionId: string;
    streamId: string;
  }>[] {
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
      streams.set(JSON.stringify([value.sessionId, value.streamId]), value);
    }
    return [...streams.values()];
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
    this.#pendingFragments -= previousFragments - updateFragments(update);
  }

  #oldestEvictable(protectedKey: string | undefined): string | undefined {
    for (const key of this.#pendingOrder.keys()) {
      if (key !== protectedKey) return key;
    }
    return undefined;
  }

  #evictPending(key: string): void {
    const sessionId = this.#pendingOrder.get(key);
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
      bytes <= MAXIMUM_PENDING_STREAM_BYTES - this.#pendingBytes &&
      fragments <= MAXIMUM_PENDING_STREAM_FRAGMENTS - this.#pendingFragments &&
      (!additionalKey || this.#pendingOrder.size < MAXIMUM_PENDING_STREAM_KEYS)
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
      const protectedSessionId = this.#pendingOrder.get(protectedKey);
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
    this.#pendingOrder.set(key, sessionId);
    this.#pendingBytes += updatePendingBytes(update);
    this.#pendingFragments += updateFragments(update);
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
      this.#pendingBytes += bytes;
      this.#pendingFragments += 1;
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
    let entry: ToolStreamEntry | undefined;
    for (const update of this.#pendingSession(sessionId)?.values() ?? []) {
      if (
        update.kind === "tool" &&
        toolKey(update.value.entry) === retainedKey
      ) {
        entry = materializeToolUpdate(update.value);
      }
    }
    return entry;
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
    if (!result.accepted) return;

    const contentBytes =
      event.content === undefined ? 0 : utf8ByteLength(event.content);
    const fragments = event.content === undefined ? 0 : 1;
    if (!this.#makeRoom(contentBytes, fragments, buffered === undefined, key)) {
      return;
    }
    const next = buffered ?? initialBufferedToolUpdate(result.entry, epoch);
    if (appendToolDelta(next, event, result.entry) === undefined) return;
    if (buffered === undefined) {
      this.#storePending(event.sessionId, key, { kind: "tool", value: next });
    } else {
      this.#pendingBytes += contentBytes;
      this.#pendingFragments += fragments;
    }
  }

  #backgroundSession(
    selectedSessionId: string | undefined,
  ): string | undefined {
    for (const sessionId of this.#pendingBySession.keys()) {
      if (sessionId !== selectedSessionId) return sessionId;
    }
    return undefined;
  }

  #takeFirst(
    sessionId: string,
    rotate: boolean,
  ): RealtimeStreamUpdate | undefined {
    const pending = this.#pendingBySession.get(sessionId);
    const next = pending?.entries().next();
    if (pending === undefined || next?.done !== false) return undefined;
    const [key] = next.value;
    const update = this.#removePending(sessionId, key);
    const remaining = this.#pendingBySession.get(sessionId);
    if (rotate && remaining !== undefined) {
      this.#pendingBySession.delete(sessionId);
      this.#pendingBySession.set(sessionId, remaining);
    }
    return update === undefined ? undefined : this.#materialize(update);
  }

  takeNext(
    maximumUpdates = 1,
    selectedSessionId?: string,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    if (selectedSessionId !== this.#selectedSessionId) {
      this.#nextSelectedTurn = true;
      this.#selectedSessionId = selectedSessionId;
    }
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const backgroundSessionId = this.#backgroundSession(selectedSessionId);
      const preferredSessionId = this.#nextSelectedTurn
        ? selectedSessionId
        : backgroundSessionId;
      const fallbackSessionId = this.#nextSelectedTurn
        ? backgroundSessionId
        : selectedSessionId;
      const sessionId =
        preferredSessionId !== undefined &&
        this.#pendingBySession.has(preferredSessionId)
          ? preferredSessionId
          : fallbackSessionId;
      if (sessionId === undefined) return undefined;
      const update = this.#takeFirst(
        sessionId,
        sessionId !== selectedSessionId,
      );
      if (update === undefined) return undefined;
      this.#nextSelectedTurn = !this.#nextSelectedTurn;
      return update;
    });
  }

  takeBarrier(
    barrier: RealtimeStreamBarrier,
    maximumUpdates = 1,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    return drainUpdates(maximumUpdates, withinBudget, () => {
      const pending = this.#pendingBySession.get(barrier.sessionId);
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
    const first = this.#pendingBySession
      .get(barrier.sessionId)
      ?.values()
      .next();
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
