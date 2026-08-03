import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import {
  parseJsonRecord,
  requiredRecordString,
} from "../shared/json-record.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  isToolStreamDeltaFrame,
  isToolStreamSnapshotFrame,
  type ToolStreamDeltaFrame,
  type ToolStreamSnapshotFrame,
} from "../shared/tool-stream.ts";
import { readRunners } from "./runner-client.tsx";
import {
  readSessionDetail,
  readSessionList,
  readSessionPendingQuestions,
} from "./session-codec.ts";

export type RealtimeServerEvent =
  | {
      readonly commandId: string;
      readonly detail?: string;
      readonly error: string;
      readonly type: "command_error";
    }
  | {
      readonly commandId: string;
      readonly result: unknown;
      readonly type: "command_success";
    }
  | { readonly instanceId: string; readonly type: "ready" }
  | ToolStreamDeltaFrame
  | ToolStreamSnapshotFrame
  | { readonly runners: readonly RunnerSummary[]; readonly type: "runners" }
  | { readonly session: AgentSessionDetail; readonly type: "session" }
  | {
      readonly pending: PendingAskQuestions | null;
      readonly sessionId: string;
      readonly type: "session_questions";
    }
  | { readonly type: "sessions_changed" }
  | {
      readonly sessions: readonly AgentSessionSummary[];
      readonly type: "sessions";
    }
  | {
      readonly content: string;
      readonly reset?: true;
      readonly sessionId: string;
      readonly streamId?: string;
      readonly thinking: string;
      readonly type: "session_delta";
    };

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  return requiredRecordString(
    value,
    key,
    "The realtime server event was invalid",
  );
}

export function readRealtimeServerEvent(message: string): RealtimeServerEvent {
  const value = parseJsonRecord(
    message,
    "The realtime server event was invalid",
  );

  switch (value["type"]) {
    case "ready":
      return { instanceId: requiredString(value, "instanceId"), type: "ready" };
    case "command_success":
      return {
        commandId: requiredString(value, "commandId"),
        result: value["result"],
        type: "command_success",
      };
    case "command_error": {
      const detail = value["detail"];
      if (detail !== undefined && typeof detail !== "string") {
        throw new Error("The realtime server event was invalid");
      }
      return {
        commandId: requiredString(value, "commandId"),
        ...(typeof detail === "string" ? { detail } : {}),
        error: requiredString(value, "error"),
        type: "command_error",
      };
    }
    case "tool_stream":
      if (!isToolStreamDeltaFrame(value)) {
        throw new Error("The realtime server event was invalid");
      }
      return value;
    case "tool_stream_snapshot":
      if (!isToolStreamSnapshotFrame(value)) {
        throw new Error("The realtime server event was invalid");
      }
      return value;
    case "runners":
      return { runners: readRunners(value), type: "runners" };
    case "sessions":
      return { sessions: readSessionList(value), type: "sessions" };
    case "session":
      return { session: readSessionDetail(value["session"]), type: "session" };
    case "session_questions":
      return {
        pending: readSessionPendingQuestions(value["pending"]),
        sessionId: requiredString(value, "sessionId"),
        type: "session_questions",
      };
    case "sessions_changed":
      return { type: "sessions_changed" };
    case "session_delta": {
      const reset = value["reset"];
      if (reset !== undefined && reset !== true) {
        throw new Error("The realtime server event was invalid");
      }
      return {
        content: requiredString(value, "content"),
        ...(reset === true ? { reset } : {}),
        sessionId: requiredString(value, "sessionId"),
        ...(typeof value["streamId"] === "string"
          ? { streamId: value["streamId"] }
          : {}),
        thinking: requiredString(value, "thinking"),
        type: "session_delta",
      };
    }
    default:
      throw new Error("The realtime server event type was invalid");
  }
}
