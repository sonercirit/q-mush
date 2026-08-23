import {
  readAttachmentFallbackSelection,
  type AttachmentFallbackSelection,
} from "../shared/attachment-fallback.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AttachmentFallbackStore } from "./attachment-fallback-store.ts";
import { createApiError, createJsonResponse, parseJsonRequest } from "./http.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";

export function createAttachmentFallbackApi(options: {
  readonly now: () => number;
  readonly requests: Pick<SessionRequestHelpers, "authenticate" | "forUser">;
  readonly store: Pick<AttachmentFallbackStore, "list" | "set">;
  readonly validate: (
    user: AuthenticatedUser,
    selection: AttachmentFallbackSelection,
  ) => Promise<boolean>;
}) {
  return {
    collection(request: Request): Promise<Response> | Response {
      if (request.method === "GET") {
        return options.requests.forUser(request, (user) =>
          createJsonResponse({ fallbacks: options.store.list(user.id) }),
        );
      }
      return options.requests.authenticate(request, "PUT", async (user) => {
        const selection = await parseJsonRequest(
          request,
          readAttachmentFallbackSelection,
        );
        if (selection === undefined)
          return createApiError("invalid_request", 400);
        if (!(await options.validate(user, selection)))
          return createApiError("fallback_model_unavailable", 409);
        options.store.set(user.id, selection, options.now());
        return createJsonResponse({ fallbacks: options.store.list(user.id) });
      });
    },
  };
}

export type AttachmentFallbackApi = ReturnType<
  typeof createAttachmentFallbackApi
>;
