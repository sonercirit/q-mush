import {
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  applyToolStreamDelta,
  type ToolStreamChannel,
  type ToolStreamDeltaFrame,
  type ToolStreamEntry,
} from "../shared/tool-stream.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";

export type SessionStreamDelta = Extract<
  RealtimeServerEvent,
  { readonly type: "session_delta" }
>;

export interface RealtimeToolStreamUpdate {
  readonly entry: ToolStreamEntry;
  readonly terminal: boolean;
  readonly type: "tool_update";
}

export type RealtimeStreamUpdate =
  RealtimeToolStreamUpdate | SessionStreamDelta;

interface BufferedMetadata {
  pendingBytes: number;
  epoch: number;
  fragments: number;
}

export interface BufferedSessionDelta extends BufferedMetadata {
  content: string[];
  readonly event: SessionStreamDelta;
  thinking: string[];
}

type ToolChannelValues = Record<ToolStreamChannel, number>;
type ToolChannelChunks = Record<ToolStreamChannel, string[]>;

export interface BufferedToolUpdate extends BufferedMetadata {
  readonly bytes: ToolChannelValues;
  chunks: ToolChannelChunks;
  entry: ToolStreamEntry;
  terminal: boolean;
}

export type BufferedStreamUpdate =
  | { readonly kind: "model"; readonly value: BufferedSessionDelta }
  | { readonly kind: "tool"; readonly value: BufferedToolUpdate };

const TOOL_STREAM_CHANNELS = [
  "arguments",
  "name",
  "stderr",
  "stdout",
] as const satisfies readonly ToolStreamChannel[];

export function modelKey(
  value: Pick<SessionStreamDelta, "sessionId" | "streamId">,
  epoch: number,
): string {
  return JSON.stringify(["model", value.sessionId, value.streamId, epoch]);
}

export function toolKey(
  value: Pick<ToolStreamEntry, "index" | "sessionId" | "streamId">,
  epoch?: number,
): string {
  return JSON.stringify([
    "tool",
    value.sessionId,
    value.streamId,
    value.index,
    ...(epoch === undefined ? [] : [epoch]),
  ]);
}

function channelBytes(entry: ToolStreamEntry): ToolChannelValues {
  return {
    arguments: utf8ByteLength(entry.arguments),
    name: utf8ByteLength(entry.name),
    stderr: utf8ByteLength(entry.stderr),
    stdout: utf8ByteLength(entry.stdout),
  };
}

export function emptyChannelChunks(): ToolChannelChunks {
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

export function materializeToolUpdate(
  buffered: BufferedToolUpdate,
): ToolStreamEntry {
  let entry = buffered.entry;
  for (const channel of TOOL_STREAM_CHANNELS) {
    entry = appendChannel(entry, channel, buffered.chunks[channel]);
  }
  return entry;
}

export function materializeModelUpdate(
  buffered: BufferedSessionDelta,
): SessionStreamDelta {
  return {
    ...buffered.event,
    content: buffered.content.join(""),
    thinking: buffered.thinking.join(""),
  };
}

export function initialBufferedToolUpdate(
  entry: ToolStreamEntry,
  epoch: number,
): BufferedToolUpdate {
  return {
    bytes: channelBytes(entry),
    chunks: emptyChannelChunks(),
    entry,
    epoch,
    fragments: 0,
    pendingBytes: 0,
    terminal: false,
  };
}

export function appendToolDelta(
  buffered: BufferedToolUpdate,
  event: ToolStreamDeltaFrame,
  entry: ToolStreamEntry,
): Readonly<{ bytes: number; fragments: number }> | undefined {
  const bytes = event.content === undefined ? 0 : utf8ByteLength(event.content);
  if (event.channel !== undefined && event.content !== undefined) {
    const channelTotal = buffered.bytes[event.channel] + bytes;
    if (channelTotal > MAXIMUM_TOOL_STREAM_FIELD_BYTES) return undefined;
    buffered.bytes[event.channel] = channelTotal;
    buffered.chunks[event.channel].push(event.content);
    buffered.fragments += 1;
    buffered.pendingBytes += bytes;
  }
  buffered.entry = entry;
  buffered.terminal = entry.state !== "preparing" && entry.state !== "running";
  return { bytes, fragments: event.content === undefined ? 0 : 1 };
}

export function validatedToolDelta(
  current: ToolStreamEntry | undefined,
  event: ToolStreamDeltaFrame,
): ReturnType<typeof applyToolStreamDelta> {
  return applyToolStreamDelta(
    current,
    event.channel === undefined ? event : { ...event, content: "" },
  );
}
