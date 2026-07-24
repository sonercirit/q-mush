import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

function readWorkspaceName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  return value["name"];
}

export interface WorkspaceIntegration {
  collection(request: Request): Promise<Response> | Response;
  item(request: Request, workspaceId: string): Promise<Response> | Response;
  setDefault(request: Request, workspaceId: string): Response;
  exists(userId: string, workspaceId: string): boolean;
  defaultForUser(userId: string): WorkspaceSummary | undefined;
}

export function createWorkspaceIntegration(options: {
  readonly auth: GoogleAuth;
  readonly now?: () => number;
  readonly store: WorkspaceStore;
}): WorkspaceIntegration {
  const now = options.now ?? Date.now;

  const collectionForUser = async (
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> => {
    if (request.method === "GET") {
      return createJsonResponse(options.store.list(user.id));
    }
    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("GET, POST");
    }
    const name = await parseJsonRequest(request, readWorkspaceName);
    if (name === undefined) {
      return createApiError("invalid_request", 400);
    }
    const created = options.store.create(user.id, name, now());
    return created === undefined
      ? createApiError("invalid_workspace", 409)
      : createJsonResponse(created, 201);
  };

  return {
    collection: (request) =>
      withAuthenticatedUser(options.auth, request, (user) =>
        collectionForUser(request, user),
      ),
    defaultForUser: (userId) => options.store.defaultForUser(userId),
    exists: (userId, workspaceId) => options.store.exists(userId, workspaceId),
    item: (request, workspaceId) =>
      withAuthenticatedUser(options.auth, request, async (user) => {
        if (request.method === "PATCH") {
          const name = await parseJsonRequest(request, readWorkspaceName);
          if (name === undefined) {
            return createApiError("invalid_request", 400);
          }
          const renamed = options.store.rename(
            user.id,
            workspaceId,
            name,
            now(),
          );
          return renamed === undefined
            ? createApiError("not_found_or_conflict", 409)
            : createJsonResponse(renamed);
        }
        if (request.method !== "DELETE") {
          return createMethodNotAllowedResponse("PATCH, DELETE");
        }
        const result = options.store.remove(user.id, workspaceId, now());
        switch (result) {
          case "last_workspace":
            return createApiError("last_workspace", 409);
          case "not_found":
            return createApiError("not_found", 404);
          case "workspace_in_use":
            return createApiError("workspace_in_use", 409);
          case "removed":
            return createNoContentResponse();
        }
      }),
    setDefault: (request, workspaceId) => {
      if (request.method !== "POST") {
        return createMethodNotAllowedResponse("POST");
      }
      return withAuthenticatedUser(options.auth, request, (user) =>
        options.store.setDefault(user.id, workspaceId, now())
          ? createNoContentResponse()
          : createApiError("not_found", 404),
      );
    },
  };
}
