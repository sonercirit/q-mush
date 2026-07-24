import { SESSIONS_PATH } from "../shared/routes.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import { HttpResponseError, request } from "./browser-http.ts";
import type { SessionViewState } from "./session-client.tsx";

export interface PendingInputAttempt {
  readonly clientRequestId: string;
  readonly images: SessionViewState["followUpImages"];
  readonly kind: "follow_up" | "steer";
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
  kind: PendingInputAttempt["kind"],
): boolean {
  return kind === "steer"
    ? status === "running"
    : status === "queued" || status === "running";
}

export async function requestPendingInput(
  attempt: PendingInputAttempt,
  settleAttempt: () => void,
): Promise<unknown> {
  // cpd-ignore-start -- Pending input deliberately mirrors the JSON mutation transport.
  try {
    const response = await request(
      `${SESSIONS_PATH}/${encodeURIComponent(attempt.sessionId)}/pending-inputs`,
      {
        body: JSON.stringify({
          clientRequestId: attempt.clientRequestId,
          ...(attempt.images.length === 0 ? {} : { images: attempt.images }),
          kind: attempt.kind,
          prompt: attempt.prompt,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    settleAttempt();
    const value: unknown = await response.json();
    return value;
  } catch (error) {
    if (error instanceof HttpResponseError) {
      settleAttempt();
    }
    throw error;
  }
  // cpd-ignore-end
}
