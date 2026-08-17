import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  applyToolStreamDelta,
  type ToolStreamChannel,
  type ToolStreamDeltaFrame,
  type ToolStreamEntry,
  type ToolStreamSnapshotFrame,
} from "../shared/tool-stream.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";

type SessionDelta = Extract<
  RealtimeServerEvent,
  { readonly type: "session_delta" }
>;
type StreamServerEvent = SessionDelta | ToolStreamDeltaFrame;

export interface RealtimeToolStreamUpdate {
  readonly entry: ToolStreamEntry;
  readonly terminal: boolean;
  readonly type: "tool_update";
}

export type RealtimeStreamUpdate = SessionDelta | RealtimeToolStreamUpdate;

export interface RealtimeStreamBatch {
  readonly type: "stream_batch";
  readonly updates: readonly RealtimeStreamUpdate[];
}

export type RealtimeClientEvent =
  Exclude<RealtimeServerEvent, StreamServerEvent> | RealtimeStreamBatch;

interface BufferedSessionDelta {
  readonly content: string[];
  readonly event: SessionDelta;
  readonly thinking: string[];
}

type ToolChannelValues = Record<ToolStreamChannel, number>;
type ToolChannelChunks = Record<ToolStreamChannel, string[]>;

interface BufferedToolUpdate {
  readonly bytes: ToolChannelValues;
  readonly chunks: ToolChannelChunks;
  entry: ToolStreamEntry;
  terminal: boolean;
}

type BufferedStreamUpdate =
  | { readonly kind: "model"; readonly value: BufferedSessionDelta }
  | { readonly kind: "tool"; readonly value: BufferedToolUpdate };

const TOOL_STREAM_CHANNELS = [
  "arguments",
  "name",
  "stderr",
  "stdout",
] as const satisfies readonly ToolStreamChannel[];

function modelKey(value: Pick<SessionDelta, "sessionId" | "streamId">): string {
  return JSON.stringify(["model", value.sessionId, value.streamId]);
}

function toolKey(
  value: Pick<ToolStreamEntry, "index" | "sessionId" | "streamId">,
): string {
  return JSON.stringify(["tool", value.sessionId, value.streamId, value.index]);
}

function channelBytes(entry: ToolStreamEntry): ToolChannelValues {
  return {
    arguments: utf8ByteLength(entry.arguments),
    name: utf8ByteLength(entry.name),
    stderr: utf8ByteLength(entry.stderr),
    stdout: utf8ByteLength(entry.stdout),
  };
}

function emptyChannelChunks(): ToolChannelChunks {
  return { arguments: [], name: [], stderr: [], stdout: [] };
}

function appendChannel(
  entry: ToolStreamEntry,
  channel: ToolStreamChannel,
  chunks: readonly string[],
): ToolStreamEntry {
  if (chunks.length === 0) return entry;
  const appended = [entry[channel], ...chunks].join("");
  switch (channel) {
    case "arguments":
      return { ...entry, arguments: appended };
    case "name":
      return { ...entry, name: appended };
    case "stderr":
      return { ...entry, stderr: appended };
    case "stdout":
      return { ...entry, stdout: appended };
  }
}

function materializeToolUpdate(buffered: BufferedToolUpdate): ToolStreamEntry {
  let entry = buffered.entry;
  for (const channel of TOOL_STREAM_CHANNELS) {
    entry = appendChannel(entry, channel, buffered.chunks[channel]);
  }
  return entry;
}

function materializeModelUpdate(buffered: BufferedSessionDelta): SessionDelta {
  return {
    ...buffered.event,
    content: buffered.content.join(""),
    thinking: buffered.thinking.join(""),
  };
}

function streamBatch(
  updates: readonly RealtimeStreamUpdate[],
): RealtimeStreamBatch | undefined {
  return updates.length === 0 ? undefined : { type: "stream_batch", updates };
}

function modelSessionMatches(
  update: BufferedStreamUpdate,
  sessionId: string,
): boolean {
  return update.kind === "model" && update.value.event.sessionId === sessionId;
}

function toolSessionMatches(
  update: BufferedStreamUpdate,
  sessionId: string,
): boolean {
  return update.kind === "tool" && update.value.entry.sessionId === sessionId;
}

function deleteMapEntries<Value>(
  entries: Map<string, Value>,
  remove: (value: Value) => boolean,
): void {
  for (const [key, value] of entries) {
    if (remove(value)) entries.delete(key);
  }
}

function reconciledToolEntry(
  local: ToolStreamEntry | undefined,
  received: ToolStreamEntry,
): ToolStreamEntry | undefined {
  if (local === undefined) return received;
  if (local.state !== "preparing" && local.state !== "running") {
    return undefined;
  }
  return local.sequence > received.sequence ? local : received;
}

export class RealtimeStreamBuffer {
  readonly #pendingBySession = new Map<
    string,
    Map<string, BufferedStreamUpdate>
  >();
  readonly #terminalToolEntries = new Map<string, ToolStreamEntry>();
  readonly #toolEntries = new Map<string, ToolStreamEntry>();

  get pending(): boolean {
    return this.#pendingBySession.size > 0;
  }

  clear(): void {
    this.clearPending();
    this.#terminalToolEntries.clear();
    this.#toolEntries.clear();
  }

  clearPending(): void {
    this.#pendingBySession.clear();
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

  #deletePending(
    sessionId: string,
    include: (update: BufferedStreamUpdate) => boolean,
  ): void {
    const pending = this.#pendingSession(sessionId);
    if (pending === undefined) return;
    deleteMapEntries(pending, include);
    if (pending.size === 0) this.#pendingBySession.delete(sessionId);
  }

  clearToolSession(sessionId: string): void {
    this.#deletePending(sessionId, (update) =>
      toolSessionMatches(update, sessionId),
    );
    deleteMapEntries(
      this.#terminalToolEntries,
      (entry) => entry.sessionId === sessionId,
    );
    deleteMapEntries(
      this.#toolEntries,
      (entry) => entry.sessionId === sessionId,
    );
  }

  queue(event: StreamServerEvent): void {
    if (event.type === "session_delta") {
      this.#queueSessionDelta(event);
    } else {
      this.#queueToolUpdate(event);
    }
  }

  #pendingForEvent(
    event: Pick<StreamServerEvent, "sessionId">,
    key: string,
  ): {
    readonly pending: Map<string, BufferedStreamUpdate> | undefined;
    readonly value: BufferedStreamUpdate | undefined;
  } {
    const pending = this.#pendingSession(event.sessionId);
    return { pending, value: pending?.get(key) };
  }

  #queueSessionDelta(event: SessionDelta): void {
    const key = modelKey(event);
    if (event.reset === true) {
      this.#deletePending(event.sessionId, (update) =>
        modelSessionMatches(update, event.sessionId),
      );
    }
    const { pending: existingPending, value } = this.#pendingForEvent(
      event,
      key,
    );
    const pending =
      existingPending ?? this.#pendingSession(event.sessionId, true);
    if (pending === undefined) return;
    const previous = value?.kind === "model" ? value.value : undefined;
    if (previous === undefined) {
      pending.set(key, {
        kind: "model",
        value: {
          content: [event.content],
          event,
          thinking: [event.thinking],
        },
      });
      return;
    }
    previous.content.push(event.content);
    previous.thinking.push(event.thinking);
  }

  #queueToolUpdate(event: ToolStreamDeltaFrame): void {
    const key = toolKey(event);
    const found = this.#pendingForEvent(event, key);
    const buffered =
      found.value?.kind === "tool" ? found.value.value : undefined;
    const current =
      buffered?.entry ??
      this.#terminalToolEntries.get(key) ??
      this.#toolEntries.get(key);
    const validationEvent =
      event.channel === undefined ? event : { ...event, content: "" };
    const result = applyToolStreamDelta(current, validationEvent);
    if (!result.accepted) return;

    const next =
      buffered ??
      ({
        bytes: channelBytes(result.entry),
        chunks: emptyChannelChunks(),
        entry: result.entry,
        terminal: false,
      } satisfies BufferedToolUpdate);
    if (event.channel !== undefined && event.content !== undefined) {
      const bytes = next.bytes[event.channel] + utf8ByteLength(event.content);
      if (bytes > MAXIMUM_TOOL_STREAM_FIELD_BYTES) return;
      next.bytes[event.channel] = bytes;
      next.chunks[event.channel].push(event.content);
    }
    next.entry = result.entry;
    next.terminal = result.terminal;
    const pending =
      found.pending ?? this.#pendingSession(event.sessionId, true);
    pending?.set(key, { kind: "tool", value: next });
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
    const [key, update] = next.value;
    pending.delete(key);
    if (pending.size === 0) {
      this.#pendingBySession.delete(sessionId);
    } else if (rotate) {
      this.#pendingBySession.delete(sessionId);
      this.#pendingBySession.set(sessionId, pending);
    }
    return this.#materialize(key, update);
  }

  takeNext(
    maximumUpdates = 1,
    selectedSessionId?: string,
    withinBudget: () => boolean = () => true,
  ): RealtimeStreamBatch | undefined {
    const updates: RealtimeStreamUpdate[] = [];
    let selectedTurn =
      selectedSessionId !== undefined &&
      this.#pendingBySession.has(selectedSessionId);
    while (
      updates.length < maximumUpdates &&
      (updates.length === 0 || withinBudget())
    ) {
      const backgroundSessionId = this.#backgroundSession(selectedSessionId);
      const preferredSessionId = selectedTurn
        ? selectedSessionId
        : backgroundSessionId;
      const fallbackSessionId = selectedTurn
        ? backgroundSessionId
        : selectedSessionId;
      const sessionId =
        preferredSessionId !== undefined &&
        this.#pendingBySession.has(preferredSessionId)
          ? preferredSessionId
          : fallbackSessionId;
      if (sessionId === undefined) break;
      const update = this.#takeFirst(
        sessionId,
        sessionId !== selectedSessionId,
      );
      if (update === undefined) break;
      updates.push(update);
      selectedTurn = !selectedTurn;
    }
    return streamBatch(updates);
  }

  takeSessionKind(
    sessionId: string,
    kind: BufferedStreamUpdate["kind"],
  ): RealtimeStreamBatch | undefined {
    return this.#takeSession(sessionId, (update) => update.kind === kind);
  }

  takeSession(sessionId: string): RealtimeStreamBatch | undefined {
    return this.#takeSession(sessionId, () => true);
  }

  #takeSession(
    sessionId: string,
    include: (update: BufferedStreamUpdate) => boolean,
  ): RealtimeStreamBatch | undefined {
    const pending = this.#pendingBySession.get(sessionId);
    if (pending === undefined) return undefined;
    const updates: RealtimeStreamUpdate[] = [];
    for (const [key, update] of pending) {
      if (!include(update)) continue;
      pending.delete(key);
      updates.push(this.#materialize(key, update));
    }
    if (pending.size === 0) this.#pendingBySession.delete(sessionId);
    return streamBatch(updates);
  }

  #trimToolEntries(
    entries: Map<string, ToolStreamEntry>,
    sessionId: string,
  ): void {
    let sessionEntries = 0;
    for (const entry of entries.values()) {
      if (entry.sessionId === sessionId) sessionEntries += 1;
    }
    while (sessionEntries > MAXIMUM_TOOL_STREAMS_PER_SESSION) {
      for (const [key, entry] of entries) {
        if (entry.sessionId !== sessionId) continue;
        entries.delete(key);
        sessionEntries -= 1;
        break;
      }
    }
    while (entries.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  #materialize(
    key: string,
    update: BufferedStreamUpdate,
  ): RealtimeStreamUpdate {
    if (update.kind === "model") {
      return materializeModelUpdate(update.value);
    }
    const entry = materializeToolUpdate(update.value);
    const terminal = update.value.terminal;
    this.#terminalToolEntries.delete(key);
    this.#toolEntries.delete(key);
    const entries = terminal ? this.#terminalToolEntries : this.#toolEntries;
    entries.set(key, entry);
    this.#trimToolEntries(entries, entry.sessionId);
    return {
      entry,
      terminal,
      type: "tool_update",
    };
  }

  #deleteToolStream(
    entries: Map<string, ToolStreamEntry>,
    snapshot: ToolStreamSnapshotFrame,
  ): void {
    deleteMapEntries(
      entries,
      (entry) =>
        entry.sessionId === snapshot.sessionId &&
        entry.streamId === snapshot.streamId,
    );
  }

  applyToolSnapshot(
    snapshot: ToolStreamSnapshotFrame,
  ): ToolStreamSnapshotFrame {
    const retained = new Map<string, ToolStreamEntry>();
    for (const received of snapshot.streams) {
      const key = toolKey(received);
      const entry = reconciledToolEntry(
        this.#terminalToolEntries.get(key) ?? this.#toolEntries.get(key),
        received,
      );
      if (entry !== undefined) retained.set(key, entry);
    }
    this.#deleteToolStream(this.#toolEntries, snapshot);
    for (const [key, entry] of retained) {
      if (this.#terminalToolEntries.has(key)) continue;
      this.#toolEntries.set(key, entry);
      this.#trimToolEntries(this.#toolEntries, entry.sessionId);
    }
    return { ...snapshot, streams: [...retained.values()] };
  }
}
