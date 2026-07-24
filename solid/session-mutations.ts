import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { readSessionDetail } from "./session-codec.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

type SessionPendingAction = "compacting" | "sending" | "stopping";

export interface SessionMutation {
  readonly action: string;
  readonly operation: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly pending: SessionPendingAction;
}

export function compactSessionMutation(sessionId: string): SessionMutation {
  return mutation(
    SESSION_REALTIME_OPERATIONS.compact,
    sessionId,
    "compact that session",
    "compacting",
  );
}

export function continueSessionMutation(sessionId: string): SessionMutation {
  return mutation(
    SESSION_REALTIME_OPERATIONS.continue,
    sessionId,
    "continue that session",
    "sending",
  );
}

export function stopSessionMutation(sessionId: string): SessionMutation {
  return mutation(
    SESSION_REALTIME_OPERATIONS.stop,
    sessionId,
    "stop that session",
    "stopping",
  );
}

export function compactionModeMutation(
  sessionId: string,
  autoCompact: boolean,
): SessionMutation {
  return {
    action: "change compaction mode",
    operation: SESSION_REALTIME_OPERATIONS.setAutoCompaction,
    payload: { autoCompact, sessionId },
    pending: "compacting",
  };
}

function mutation(
  operation: string,
  sessionId: string,
  action: string,
  pending: SessionPendingAction,
): SessionMutation {
  return { action, operation, payload: { sessionId }, pending };
}

export async function executeSessionMutation(
  transport: SessionCommandTransport,
  mutation: SessionMutation,
): Promise<AgentSessionDetail> {
  const value = await transport.command(mutation.operation, mutation.payload);
  if (typeof value !== "object" || value === null) {
    throw new Error("The session mutation acknowledgement was invalid");
  }
  return readSessionDetail(value);
}

export function sessionMutationError(error: unknown, action: string): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (
    code === "runner_unavailable" ||
    code === "credential_unavailable" ||
    code === "session_busy"
  ) {
    return "The selected runner or credential is unavailable, or the session is busy.";
  }
  if (code === "connection_stopped") {
    return "The realtime connection is unavailable. Reconnect and try again.";
  }
  return `We could not ${action}. Please try again.`;
}
