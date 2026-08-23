import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError } from "./http.ts";
import type { QueueSessionResult } from "./session-store-queue.ts";

export function queueFailureResponse(
  result: Exclude<QueueSessionResult, { readonly status: "queued" }>,
): Response {
  const responses: Record<typeof result.status, () => Response> = {
    busy: () => createApiError("session_busy", 409),
    callback_pending: () => createApiError("callback_pending", 409),
    not_found: () => createApiError("not_found", 404),
    parent_stale: () => createApiError("parent_stale", 409),
    pending_input_conflict: () => createApiError("pending_input_conflict", 409),
    runner_required: () => createApiError("runner_required", 409),
    runner_unavailable: () => createApiError("runner_unavailable", 409),
  };
  return responses[result.status]();
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
