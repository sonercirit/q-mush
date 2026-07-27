import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import type { CollectionItemIntegration } from "./collection-item-integration.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
} from "./http.ts";
import {
  optionalResultResponse,
  withParsedUserInput,
} from "./parsed-user-input.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

function readWorkspaceName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  return value["name"];
}

export interface WorkspaceIntegration extends CollectionItemIntegration {
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

  const writeWorkspace = (
    request: Request,
    user: AuthenticatedUser,
    write: (userId: string, name: string) => WorkspaceSummary | undefined,
    present: (workspace: WorkspaceSummary) => Response,
    error: string,
  ): Promise<Response> =>
    withParsedUserInput(request, user, readWorkspaceName, (userId, name) =>
      optionalResultResponse(write(userId, name), present, error, 409),
    );

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
    return writeWorkspace(
      request,
      user,
      (userId, name) => options.store.create(userId, name, now()),
      (created) => createJsonResponse(created, 201),
      "invalid_workspace",
    );
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
          return writeWorkspace(
            request,
            user,
            (userId, name) =>
              options.store.rename(userId, workspaceId, name, now()),
            createJsonResponse,
            "not_found_or_conflict",
          );
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
