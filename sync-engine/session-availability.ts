import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError } from "./http.ts";

export function unavailableSessionResponse(
  detail: AgentSessionDetail | undefined,
): Response | undefined {
  if (detail === undefined) {
    return createApiError("not_found", 404);
  }
  return detail.status === "queued" ||
    detail.status === "running" ||
    detail.status === "paused"
    ? createApiError("session_busy", 409)
    : undefined;
}
