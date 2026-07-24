import { isRecord } from "../shared/auth-model.ts";
import {
  parseJsonRecord,
  requiredRecordString,
} from "../shared/json-record.ts";
import { readProviderLimitState } from "../shared/provider-limits-codec.ts";
import type { ProviderLimitState } from "../shared/provider-limits.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { readRunners } from "./runner-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";

export type RealtimeServerEvent =
  | {
      readonly credentialId: string;
      readonly limits: ProviderLimitState;
      readonly type: "provider_limits";
    }
  | {
      readonly credentials: readonly {
        readonly credentialId: string;
        readonly limits: ProviderLimitState;
      }[];
      readonly type: "provider_limits_snapshot";
    }
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

function readLimits(value: unknown): ProviderLimitState {
  const limits = readProviderLimitState(value);
  if (limits === undefined) {
    throw new Error("The realtime server event was invalid");
  }
  return limits;
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("The realtime server event was invalid");
  }
  return value;
}

function readLimitSnapshot(value: unknown) {
  return readArray(value).map((item) => {
    if (!isRecord(item)) {
      throw new Error("The realtime server event was invalid");
    }
    return {
      credentialId: requiredString(item, "credentialId"),
      limits: readLimits(item["limits"]),
    };
  });
}

export function readRealtimeServerEvent(message: string): RealtimeServerEvent {
  const value = parseJsonRecord(
    message,
    "The realtime server event was invalid",
  );

  switch (value["type"]) {
    case "provider_limits":
      return {
        credentialId: requiredString(value, "credentialId"),
        limits: readLimits(value["limits"]),
        type: "provider_limits",
      };
    case "provider_limits_snapshot":
      return {
        credentials: readLimitSnapshot(value["credentials"]),
        type: "provider_limits_snapshot",
      };
    case "runners":
      return { runners: readRunners(value), type: "runners" };
    case "sessions":
      return { sessions: readSessionList(value), type: "sessions" };
    case "session":
      return { session: readSessionDetail(value["session"]), type: "session" };
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
