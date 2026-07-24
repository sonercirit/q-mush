import { isRecord } from "../shared/auth-model.ts";
import {
  parseJsonRecord,
  requiredRecordString,
} from "../shared/json-record.ts";
import { isNonnegativeSafeInteger } from "../shared/number.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  isToolStreamTerminalState,
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH,
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  type ToolStreamChannel,
  type ToolStreamDelta,
  type ToolStreamEntry,
  type ToolStreamState,
} from "../shared/tool-stream.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import { readRunners } from "./runner-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";

export type RealtimeServerEvent =
  | { readonly runners: readonly RunnerSummary[]; readonly type: "runners" }
  | { readonly session: AgentSessionDetail; readonly type: "session" }
  | {
      readonly sessions: readonly AgentSessionSummary[];
      readonly type: "sessions";
    }
  | {
      readonly content: string;
      readonly reset?: true;
      readonly sessionId: string;
      readonly streamId: string;
      readonly thinking: string;
      readonly type: "session_delta";
    }
  | (ToolStreamDelta & { readonly type: "tool_stream" })
  | {
      readonly sessionId: string;
      readonly streams: readonly ToolStreamEntry[];
      readonly streamId: string;
      readonly type: "tool_stream_snapshot";
    };

const INVALID_EVENT = "The realtime server event was invalid";
function invalidEvent(): never {
  throw new RangeError([INVALID_EVENT, "codec"].join(": "));
}

function boundedString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumBytes: number,
): string {
  const selected = requiredRecordString(value, key, INVALID_EVENT);
  if (utf8ByteLength(selected) <= maximumBytes) {
    return selected;
  }
  return invalidEvent();
}

function requiredIdentifier(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const selected = boundedString(
    value,
    key,
    MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH,
  );
  if (!selected) {
    invalidEvent();
  }
  return selected;
}

function requiredSequence(
  value: Readonly<Record<string, unknown>>,
  key = "sequence",
): number {
  const sequence = value[key];
  if (!isNonnegativeSafeInteger(sequence)) {
    invalidEvent();
  }
  return sequence;
}

function optionalToolChannel(value: unknown): ToolStreamChannel | undefined {
  return value === "arguments" ||
    value === "name" ||
    value === "stderr" ||
    value === "stdout"
    ? value
    : undefined;
}

function optionalToolState(value: unknown): ToolStreamState | undefined {
  return value === "preparing" ||
    value === "running" ||
    isToolStreamTerminalState(value)
    ? value
    : undefined;
}

function readToolStreamEntry(value: unknown): ToolStreamEntry {
  if (!isRecord(value)) {
    invalidEvent();
  }
  const state = optionalToolState(value["state"]);
  if (state === undefined) {
    invalidEvent();
  }
  return {
    arguments: boundedString(
      value,
      "arguments",
      MAXIMUM_TOOL_STREAM_FIELD_BYTES,
    ),
    callId: requiredIdentifier(value, "callId"),
    index: requiredSequence(value, "index"),
    name: boundedString(value, "name", MAXIMUM_TOOL_STREAM_FIELD_BYTES),
    sequence: requiredSequence(value),
    sessionId: requiredIdentifier(value, "sessionId"),
    state,
    stderr: boundedString(value, "stderr", MAXIMUM_TOOL_STREAM_FIELD_BYTES),
    stdout: boundedString(value, "stdout", MAXIMUM_TOOL_STREAM_FIELD_BYTES),
    streamId: requiredIdentifier(value, "streamId"),
  };
}

export function readRealtimeServerEvent(message: string): RealtimeServerEvent {
  const value = parseJsonRecord(message, INVALID_EVENT);

  switch (value["type"]) {
    case "runners":
      return { runners: readRunners(value), type: "runners" };
    case "sessions":
      return { sessions: readSessionList(value), type: "sessions" };
    case "session":
      return { session: readSessionDetail(value["session"]), type: "session" };
    case "session_delta": {
      const reset = value["reset"];
      if (reset !== undefined && reset !== true) {
        invalidEvent();
      }
      return {
        content: requiredRecordString(value, "content", INVALID_EVENT),
        ...(reset === true ? { reset } : {}),
        sessionId: requiredRecordString(value, "sessionId", INVALID_EVENT),
        streamId: requiredRecordString(value, "streamId", INVALID_EVENT),
        thinking: requiredRecordString(value, "thinking", INVALID_EVENT),
        type: "session_delta",
      };
    }
    case "tool_stream": {
      const channel = optionalToolChannel(value["channel"]);
      const content = value["content"];
      const previousCallId = value["previousCallId"];
      const sequenceStart = value["sequenceStart"];
      const state = optionalToolState(value["state"]);
      if (
        (channel === undefined) !== (content === undefined) ||
        (content !== undefined &&
          (typeof content !== "string" ||
            content.length === 0 ||
            utf8ByteLength(content) > MAXIMUM_TOOL_STREAM_DELTA_BYTES)) ||
        (value["channel"] !== undefined && channel === undefined) ||
        (value["state"] !== undefined && state === undefined) ||
        (sequenceStart !== undefined &&
          !isNonnegativeSafeInteger(sequenceStart)) ||
        (previousCallId !== undefined &&
          (typeof previousCallId !== "string" ||
            previousCallId.length === 0 ||
            utf8ByteLength(previousCallId) >
              MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH)) ||
        (channel === undefined &&
          state === undefined &&
          previousCallId === undefined)
      ) {
        invalidEvent();
      }
      const common = {
        callId: requiredIdentifier(value, "callId"),
        index: requiredSequence(value, "index"),
        ...(typeof previousCallId === "string" ? { previousCallId } : {}),
        sequence: requiredSequence(value),
        ...(typeof sequenceStart === "number" ? { sequenceStart } : {}),
        sessionId: requiredIdentifier(value, "sessionId"),
        ...(state === undefined ? {} : { state }),
        streamId: requiredIdentifier(value, "streamId"),
        type: "tool_stream" as const,
      };
      return channel !== undefined && typeof content === "string"
        ? { ...common, channel, content }
        : common;
    }
    case "tool_stream_snapshot": {
      const streams = value["streams"];
      if (
        !Array.isArray(streams) ||
        streams.length > MAXIMUM_TOOL_STREAMS_PER_SESSION
      ) {
        invalidEvent();
      }
      return {
        sessionId: requiredIdentifier(value, "sessionId"),
        streams: streams.map(readToolStreamEntry),
        streamId: requiredIdentifier(value, "streamId"),
        type: "tool_stream_snapshot",
      };
    }
    default:
      throw new Error("The realtime server event type was invalid");
  }
}
