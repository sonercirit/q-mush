import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import { readIdentifier } from "./session-request-helpers.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionWorkspaceReader {
  defaultForUser(userId: string): { readonly id: string } | undefined;
  exists(userId: string, workspaceId: string): boolean;
}

export function requestSessionWorkspaceId(
  request: Request,
  userId: string,
  workspaces: SessionWorkspaceReader,
): string | undefined {
  const supplied = new URL(request.url).searchParams.get("workspaceId");
  const workspaceId =
    supplied === null
      ? workspaces.defaultForUser(userId)?.id
      : readIdentifier(supplied);
  return workspaceId !== undefined && workspaces.exists(userId, workspaceId)
    ? workspaceId
    : undefined;
}

export function withRequestSessionWorkspace<
  Result extends Promise<Response> | Response,
>(
  request: Request,
  user: AuthenticatedUser,
  workspaces: SessionWorkspaceReader,
  action: (workspaceId: string) => Result,
): Response | Result {
  const workspaceId = requestSessionWorkspaceId(request, user.id, workspaces);
  return workspaceId === undefined
    ? createApiError("workspace_unavailable", 409)
    : action(workspaceId);
}

export function withStoredWorkspaceSession(
  store: SessionStore,
  user: AuthenticatedUser,
  sessionId: string,
  workspaceId: string,
  action: (session: AgentSessionDetail) => Promise<Response> | Response,
): Promise<Response> | Response {
  const session = store.get(user.id, sessionId, workspaceId);
  return session === undefined
    ? createApiError("not_found", 404)
    : action(session);
}

export function storedSessionResponse(
  store: SessionStore,
  userId: string,
  sessionId: string,
  workspaceId: string,
): Response {
  const detail = store.get(userId, sessionId, workspaceId);
  return detail === undefined
    ? createApiError("not_found", 404)
    : createJsonResponse(detail);
}
