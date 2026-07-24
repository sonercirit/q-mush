import type { AgentSessionDetail } from "../shared/session-model.ts";

export function unavailableSessionError(
  detail: AgentSessionDetail,
): "session_busy" | undefined {
  return detail.status === "queued" || detail.status === "running"
    ? "session_busy"
    : undefined;
}
