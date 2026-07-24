import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { SessionCredentialReassignmentResult } from "../shared/session-credential-reassignment.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type { SessionCredentialReassignmentStore } from "./session-credential-reassignment-store.ts";

export interface SessionCredentialReassignmentOptions {
  readonly auth: GoogleAuth;
  readonly now: () => number;
  readonly onChanged?: (userId: string) => void;
  readonly provider: ProviderId;
  readonly store:
    Pick<SessionCredentialReassignmentStore, "reassign"> | undefined;
}

export class SessionCredentialReassignmentEndpoints {
  readonly #options: SessionCredentialReassignmentOptions;

  constructor(options: SessionCredentialReassignmentOptions) {
    this.#options = options;
  }

  reassign(request: Request, credentialId: string): Promise<Response> {
    if (request.method !== "POST") {
      return Promise.resolve(createMethodNotAllowedResponse("POST"));
    }

    return Promise.resolve(
      withAuthenticatedUser(this.#options.auth, request, (user) =>
        this.#reassignForUser(request, user, credentialId),
      ),
    );
  }

  async #reassignForUser(
    request: Request,
    user: AuthenticatedUser,
    credentialId: string,
  ): Promise<Response> {
    const body = await parseJsonRequest(request, (value) =>
      isRecord(value) && Object.keys(value).length === 0 ? true : undefined,
    );
    if (body === undefined) {
      return createApiError("invalid_request", 400);
    }

    const result: SessionCredentialReassignmentResult | undefined =
      this.#options.store?.reassign(
        user.id,
        this.#options.provider,
        credentialId,
        this.#options.now(),
      );
    if (result === undefined) {
      return this.#options.store === undefined
        ? createApiError("not_configured", 503)
        : createApiError("not_found", 404);
    }

    if (result.migratedSessionCount > 0) {
      this.#options.onChanged?.(user.id);
    }
    return createJsonResponse(result);
  }
}
