import {
  readSessionCompactionRealtimeEvent,
  type SessionCompactionRealtimeEvent,
} from "../shared/compaction-realtime.ts";
import {
  parseJsonRecord,
  requiredRecordString,
} from "../shared/json-record.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { readRunners } from "./runner-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";

export type RealtimeServerEvent =
  | SessionCompactionRealtimeEvent
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
    case "runners":
      return { runners: readRunners(value), type: "runners" };
    case "sessions":
      return { sessions: readSessionList(value), type: "sessions" };
    case "session":
      return { session: readSessionDetail(value["session"]), type: "session" };
    case "session_compaction":
      return readSessionCompactionRealtimeEvent(value);
    case "session_delta": {
      const reset = value["reset"];
      if (reset !== undefined && reset !== true) {
        throw new Error("The realtime server event was invalid");
      }
      return {
        content: requiredString(value, "content"),
        ...(reset === true ? { reset } : {}),
        sessionId: requiredString(value, "sessionId"),
        thinking: requiredString(value, "thinking"),
        type: "session_delta",
      };
    }
    default:
      throw new Error("The realtime server event type was invalid");
  }
}
