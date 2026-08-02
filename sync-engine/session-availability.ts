import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError } from "./http.ts";
import type { QueueSessionResult } from "./session-store-queue.ts";

export function queueFailureResponse(
  result: Exclude<QueueSessionResult, { readonly status: "queued" }>,
): Response {
  switch (result.status) {
    case "busy":
      return createApiError("session_busy", 409);
    case "callback_pending":
      return createApiError("callback_pending", 409);
    case "not_found":
      return createApiError("not_found", 404);
    case "parent_stale":
      return createApiError("parent_stale", 409);
    case "pending_input_conflict":
      return createApiError("pending_input_conflict", 409);
    case "runner_required":
      return createApiError("runner_required", 409);
    case "runner_unavailable":
      return createApiError("runner_unavailable", 409);
  }
}

export function unavailableSessionResponse(
  detail: AgentSessionDetail | undefined,
): Response | undefined {
  if (detail === undefined) {
    return createApiError("not_found", 404);
  }
  if (detail.runnerRequired) {
    return createApiError("runner_required", 409);
  }
  return detail.status === "paused" ||
    detail.status === "queued" ||
    detail.status === "running"
    ? createApiError("session_busy", 409)
    : undefined;
}
