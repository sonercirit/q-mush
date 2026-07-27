import type {
  AgentSessionPendingInputKind,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import type { SessionPendingInputRequest } from "../shared/session-pending-input.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export interface PendingInputAttempt extends SessionPendingInputRequest {
  readonly prompt: string;
  readonly sessionId: string;
}

export function samePendingInputAttempt(
  attempt: PendingInputAttempt,
  requested: Omit<PendingInputAttempt, "clientRequestId">,
): boolean {
  return (
    attempt.sessionId === requested.sessionId &&
    attempt.kind === requested.kind &&
    attempt.prompt === requested.prompt &&
    JSON.stringify(attempt.images) === JSON.stringify(requested.images)
  );
}

export function sessionCanQueuePendingInput(
  status: AgentSessionStatus,
  kind: AgentSessionPendingInputKind,
): boolean {
  const active = status === "queued" || status === "running";
  return kind === "follow_up" ? active : status === "running";
}

/** @public Maps a pending-input kind to its realtime operation. */
export function pendingInputOperation(
  kind: AgentSessionPendingInputKind,
): "sessions.follow_up" | "sessions.steer" {
  return kind === "follow_up" ? "sessions.follow_up" : "sessions.steer";
}

export function requestPendingInput(
  transport: SessionCommandTransport,
  attempt: PendingInputAttempt,
): Promise<unknown> {
  return transport.command(
    pendingInputOperation(attempt.kind),
    {
      clientRequestId: attempt.clientRequestId,
      ...(attempt.images.length === 0 ? {} : { images: attempt.images }),
      kind: attempt.kind,
      prompt: attempt.prompt,
      sessionId: attempt.sessionId,
    },
    attempt.clientRequestId,
  );
}
