import { HttpResponseError, requestJson } from "./browser-http.ts";
import { SESSIONS_PATH } from "./routes.ts";
import { readSessionDetail } from "./session-codec.ts";
import type { AgentSessionDetail } from "./session-model.ts";

type SessionPendingAction = "compacting" | "sending" | "stopping";

export interface SessionMutation {
  readonly action: string;
  readonly pending: SessionPendingAction;
  readonly request: () => Promise<unknown>;
}

export function compactSessionMutation(sessionId: string): SessionMutation {
  return postMutation(
    sessionId,
    "compact",
    "compact that session",
    "compacting",
  );
}

export function continueSessionMutation(sessionId: string): SessionMutation {
  return postMutation(
    sessionId,
    "continue",
    "continue that session",
    "sending",
  );
}

export function stopSessionMutation(sessionId: string): SessionMutation {
  return postMutation(sessionId, "stop", "stop that session", "stopping");
}

export function compactionModeMutation(
  sessionId: string,
  autoCompact: boolean,
): SessionMutation {
  return {
    action: "change compaction mode",
    pending: "compacting",
    request: () =>
      requestJson(
        `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/compaction`,
        {
          body: JSON.stringify({ autoCompact }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
  };
}

function postMutation(
  sessionId: string,
  endpoint: "compact" | "continue" | "stop",
  action: string,
  pending: SessionPendingAction,
): SessionMutation {
  return {
    action,
    pending,
    request: () =>
      requestJson(
        `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/${endpoint}`,
        { method: "POST" },
      ),
  };
}

export async function executeSessionMutation(
  mutation: SessionMutation,
): Promise<AgentSessionDetail> {
  return readSessionDetail(await mutation.request());
}

export function sessionMutationError(error: unknown, action: string): string {
  if (error instanceof HttpResponseError && error.status === 409) {
    return "The selected runner or credential is unavailable, or the session is busy.";
  }

  return `We could not ${action}. Please try again.`;
}
