import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import { readSessionReassignment } from "./session-reassignment.ts";
import type { SessionRequestAuthenticator } from "./session-request-helpers.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionReassignmentDependencies {
  readonly store: Pick<SessionStore, "reassign">;
  readonly authenticate: SessionRequestAuthenticator;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
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
      const result = dependencies.store.reassign(
        user.id,
        sessionId,
        input.runnerId,
        input.workingDirectory,
        dependencies.now(),
      );
      if (result.status !== "reassigned") {
        const notFound = result.status === "not_found";
        return createApiError(
          notFound
            ? "not_found"
            : result.status === "runner_unavailable"
              ? "runner_unavailable"
              : `session_${result.status}`,
          notFound ? 404 : 409,
        );
      }
      dependencies.notify(user.id, sessionId);
      return createJsonResponse(result.detail);
    }),
  );
}
