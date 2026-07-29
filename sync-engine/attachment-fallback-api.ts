import {
  readAttachmentFallbackSelection,
  type AttachmentFallbackSelection,
} from "../shared/attachment-fallback.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AttachmentFallbackStore } from "./attachment-fallback-store.ts";
import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";

export class AttachmentFallbackApi {
  readonly #requests: Pick<SessionRequestHelpers, "authenticate" | "forUser">;
  readonly #store: Pick<AttachmentFallbackStore, "list" | "set">;
  readonly #now: () => number;
  readonly #validate: (
    user: AuthenticatedUser,
    selection: AttachmentFallbackSelection,
  ) => Promise<boolean>;

  constructor(options: {
    readonly now: () => number;
    readonly requests: Pick<SessionRequestHelpers, "authenticate" | "forUser">;
    readonly store: Pick<AttachmentFallbackStore, "list" | "set">;
    readonly validate: (
      user: AuthenticatedUser,
      selection: AttachmentFallbackSelection,
    ) => Promise<boolean>;
  }) {
    this.#now = options.now;
    this.#requests = options.requests;
    this.#store = options.store;
    this.#validate = options.validate;
  }

  collection(request: Request): Promise<Response> | Response {
    if (request.method === "GET") {
      return this.#requests.forUser(request, (user) =>
        createJsonResponse({ fallbacks: this.#store.list(user.id) }),
      );
    }
    return this.#requests.authenticate(request, "PUT", async (user) => {
      const selection = await parseJsonRequest(
        request,
        readAttachmentFallbackSelection,
      );
      if (selection === undefined)
        return createApiError("invalid_request", 400);
      if (!(await this.#validate(user, selection))) {
        return createApiError("fallback_model_unavailable", 409);
      }
      this.#store.set(user.id, selection, this.#now());
      return createJsonResponse({ fallbacks: this.#store.list(user.id) });
    });
  }
}
