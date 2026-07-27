import type { AuthenticatedUser } from "../shared/auth-model.ts";
import {
  requestedWorkspaceId,
  type ScopeAuthenticator,
  updateConnectionScopes,
} from "./connection-scope-request.ts";
import { createJsonResponse } from "./http.ts";

export function workspaceScopedCollectionResponse(
  request: Request,
  user: AuthenticatedUser,
  read: (userId: string, workspaceId?: string) => readonly unknown[],
  validate: (userId: string, workspaceId: string) => boolean,
  key: "credentials" | "runners",
): Response {
  const workspaceId = requestedWorkspaceId(request, (id) =>
    validate(user.id, id),
  );
  if (workspaceId instanceof Response) {
    return workspaceId;
  }
  return createJsonResponse({ [key]: read(user.id, workspaceId ?? undefined) });
}

export function updateAuthenticatedConnectionScopes(
  request: Request,
  authenticate: ScopeAuthenticator,
  update: (userId: string, workspaceIds: readonly string[]) => boolean,
): Promise<Response> {
  return updateConnectionScopes(request, {
    authenticate: (action) => Promise.resolve(authenticate(action)),
    update,
  });
}
