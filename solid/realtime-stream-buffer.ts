import {
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
  readonly #pending = new Map<string, BufferedStreamUpdate>();
  readonly #toolEntries = new Map<string, ToolStreamEntry>();

  get pending(): boolean {
    return this.#pending.size > 0;
  }

  clear(): void {
    this.#pending.clear();
    this.#toolEntries.clear();
  }

  clearToolSession(sessionId: string): void {
    deleteMapEntries(this.#pending, (update) =>
      toolSessionMatches(update, sessionId),
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

  #queueSessionDelta(event: SessionDelta): void {
    if (event.reset === true) {
      deleteMapEntries(this.#pending, (update) =>
        modelSessionMatches(update, event.sessionId),
      );
    }
    const key = modelKey(event);
    const pending = this.#pending.get(key);
    const previous = pending?.kind === "model" ? pending.value : undefined;
    if (previous === undefined) {
      this.#pending.set(key, {
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
    const pending = this.#pending.get(key);
    const buffered = pending?.kind === "tool" ? pending.value : undefined;
    const current = buffered?.entry ?? this.#toolEntries.get(key);
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
    this.#pending.set(key, { kind: "tool", value: next });
  }

  takeNext(): RealtimeStreamBatch | undefined {
    const key = this.#pending.keys().next().value;
    return key === undefined ? undefined : this.#takeKey(key);
  }

  takeSessionKind(
    sessionId: string,
    kind: BufferedStreamUpdate["kind"],
  ): RealtimeStreamBatch | undefined {
    const match = (update: BufferedStreamUpdate): boolean =>
      update.kind === kind &&
      (kind === "model"
        ? modelSessionMatches(update, sessionId)
        : toolSessionMatches(update, sessionId));
    return this.#take(match);
  }

  takeSession(sessionId: string): RealtimeStreamBatch | undefined {
    return this.#take(
      (update) =>
        modelSessionMatches(update, sessionId) ||
        toolSessionMatches(update, sessionId),
    );
  }

  #take(
    include: (update: BufferedStreamUpdate) => boolean,
  ): RealtimeStreamBatch | undefined {
    const updates: RealtimeStreamUpdate[] = [];
    for (const [key, update] of this.#pending) {
      if (!include(update)) continue;
      this.#pending.delete(key);
      updates.push(this.#materialize(key, update));
    }
    return streamBatch(updates);
  }

  #takeKey(key: string): RealtimeStreamBatch | undefined {
    const update = this.#pending.get(key);
    if (update === undefined) return undefined;
    this.#pending.delete(key);
    return streamBatch([this.#materialize(key, update)]);
  }

  #materialize(
    key: string,
    update: BufferedStreamUpdate,
  ): RealtimeStreamUpdate {
    if (update.kind === "model") {
      return materializeModelUpdate(update.value);
    }
    const entry = materializeToolUpdate(update.value);
    this.#toolEntries.set(key, entry);
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
      const entry = reconciledToolEntry(this.#toolEntries.get(key), received);
      if (entry !== undefined) retained.set(key, entry);
    }
    deleteMapEntries(
      this.#toolEntries,
      (entry) =>
        entry.sessionId === snapshot.sessionId &&
        entry.streamId === snapshot.streamId,
    );
    for (const [key, entry] of retained) this.#toolEntries.set(key, entry);
    return { ...snapshot, streams: [...retained.values()] };
  }
}
