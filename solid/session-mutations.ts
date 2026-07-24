import { SESSIONS_PATH } from "../shared/routes.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { HttpResponseError, requestJson } from "./browser-http.ts";
import { readSessionDetail } from "./session-codec.ts";

type SessionPendingAction = "compacting" | "sending" | "stopping";

export interface SessionMutation {
  readonly action: string;
  readonly pending: SessionPendingAction;
  readonly request: () => Promise<unknown>;
}

function sessionMutationPath(
  sessionId: string,
  workspaceId: string,
  endpoint: "compact" | "continue" | "stop",
): string {
  return (
    `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/${endpoint}` +
    `?workspaceId=${encodeURIComponent(workspaceId)}`
  );
}

export function compactSessionMutation(
  sessionId: string,
  workspaceId: string,
): SessionMutation {
  return postMutation(
    sessionId,
    workspaceId,
    "compact",
    "compact that session",
    "compacting",
  );
}

export function continueSessionMutation(
  sessionId: string,
  workspaceId: string,
): SessionMutation {
  return postMutation(
    sessionId,
    workspaceId,
    "continue",
    "continue that session",
    "sending",
  );
}

export function stopSessionMutation(
  sessionId: string,
  workspaceId: string,
): SessionMutation {
  return postMutation(
    sessionId,
    workspaceId,
    "stop",
    "stop that session",
    "stopping",
  );
}

export function compactionModeMutation(
  sessionId: string,
  workspaceId: string,
  autoCompact: boolean,
): SessionMutation {
  return {
    action: "change compaction mode",
    pending: "compacting",
    request: () =>
      requestJson(
        `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/compaction?workspaceId=${encodeURIComponent(workspaceId)}`,
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
  workspaceId: string,
  endpoint: "compact" | "continue" | "stop",
  action: string,
  pending: SessionPendingAction,
): SessionMutation {
  return {
    action,
    pending,
    request: () =>
      requestJson(sessionMutationPath(sessionId, workspaceId, endpoint), {
        method: "POST",
      }),
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
