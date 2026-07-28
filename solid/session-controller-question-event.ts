import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import { reconcilePendingQuestions } from "./session-request.ts";

export function updatedSessionQuestions(
  detail: AgentSessionDetail | undefined,
  event: Extract<RealtimeServerEvent, { type: "session_questions" }>,
): AgentSessionDetail | undefined {
  if (
    detail?.id !== event.sessionId ||
    (event.pending?.executionGeneration !== undefined &&
      event.pending.executionGeneration !== detail.generation) ||
    (event.pending !== null && detail.status !== "paused")
  ) {
    return undefined;
  }
  const pendingQuestions = reconcilePendingQuestions(
    detail.pendingQuestions,
    event.pending,
  );
  return pendingQuestions === detail.pendingQuestions
    ? undefined
    : { ...detail, pendingQuestions };
}
