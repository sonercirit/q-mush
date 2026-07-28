import { isRecord } from "../shared/auth-model.ts";
import { isWorkspaceId } from "../shared/workspace-model.ts";
import type { AuthenticatedUserAction } from "./authenticated-get.ts";
import {
  createApiError,
  createNoContentResponse,
  parseJsonRequest,
  requireRequestMethod,
} from "./http.ts";
import { requestWorkspaceId } from "./request-workspace.ts";

export function requestedWorkspaceId(
  request: Request,
  validate: (workspaceId: string) => boolean,
): string | null | Response {
  const workspaceId = requestWorkspaceId(request);
  return workspaceId !== null && !validate(workspaceId)
    ? createApiError("invalid_scope", 409)
    : workspaceId;
}

export type ScopeAuthenticator = (
  action: AuthenticatedUserAction,
) => Promise<Response> | Response;

export async function updateConnectionScopes(
  request: Request,
  options: Readonly<{
    authenticate: ScopeAuthenticator;
    update: (userId: string, workspaceIds: readonly string[]) => boolean;
  }>,
): Promise<Response> {
  const methodError = requireRequestMethod(request, "PUT");
  if (methodError !== undefined) return methodError;
  return Promise.resolve(
    options.authenticate(async (user) => {
      const workspaceIds = await parseJsonRequest(request, (value) => {
        if (!isRecord(value) || !Array.isArray(value["workspaceIds"])) {
          return undefined;
        }
        const ids = value["workspaceIds"];
        return ids.length > 0 && ids.every(isWorkspaceId)
          ? ids.map(String)
          : undefined;
      });
      if (workspaceIds === undefined) {
        return createApiError("invalid_request", 400);
      }
      return options.update(user.id, workspaceIds)
        ? createNoContentResponse()
        : createApiError("invalid_scope", 409);
    }),
  );
}
