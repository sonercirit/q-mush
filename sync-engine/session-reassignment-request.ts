import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import {
  readSessionReassignment,
  type SessionReassignmentInput,
} from "./session-reassignment.ts";
import type { SessionRequestAuthenticator } from "./session-request-helpers.ts";
import type { ReassignSessionResult } from "./session-store-reassignment.ts";
import type { SessionStore } from "./session-store.ts";
import {
  requestSessionWorkspaceId,
  type SessionWorkspaceReader,
} from "./session-workspace.ts";

export function sessionReassignmentError(
  result: Exclude<ReassignSessionResult, { readonly status: "reassigned" }>,
): string {
  return result.status === "not_found"
    ? "not_found"
    : result.status === "runner_unavailable"
      ? "runner_unavailable"
      : `session_${result.status}`;
}

export interface SessionReassignmentDependencies {
  readonly authenticate: SessionRequestAuthenticator;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly store: Pick<SessionStore, "get" | "reassign">;
  readonly workspaces?: SessionWorkspaceReader;
}

export function reassignSession(
  dependencies: Pick<SessionReassignmentDependencies, "now" | "store">,
  userId: string,
  sessionId: string,
  input: SessionReassignmentInput,
  workspaceId?: string,
): ReassignSessionResult {
  if (
    workspaceId !== undefined &&
    dependencies.store.get(userId, sessionId, workspaceId) === undefined
  ) {
    return { status: "not_found" };
  }
  return dependencies.store.reassign(
    userId,
    sessionId,
    input.runnerId,
    input.workingDirectory,
    dependencies.now(),
  );
}

export async function reassignSessionRequest(
  dependencies: SessionReassignmentDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  return await Promise.resolve(
    dependencies.authenticate(request, "POST", async (user) => {
      const input = await parseJsonRequest(request, readSessionReassignment);
      if (input === undefined) {
        return createApiError("invalid_request", 400);
      }
      const workspaceId =
        dependencies.workspaces === undefined
          ? undefined
          : requestSessionWorkspaceId(
              request,
              user.id,
              dependencies.workspaces,
            );
      if (dependencies.workspaces !== undefined && workspaceId === undefined) {
        return createApiError("workspace_unavailable", 409);
      }
      const result = reassignSession(
        dependencies,
        user.id,
        sessionId,
        input,
        workspaceId,
      );
      if (result.status !== "reassigned") {
        const code = sessionReassignmentError(result);
        return createApiError(code, code === "not_found" ? 404 : 409);
      }
      dependencies.notify(user.id, sessionId);
      return createJsonResponse(result.detail);
    }),
  );
}
