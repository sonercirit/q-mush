import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import { readPendingInput } from "./session-input.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- This small adapter mirrors the central authenticated-request contract.
interface PendingInputRequestDependencies {
  readonly authenticate: <Result extends Promise<Response> | Response>(
    request: Request,
    method: string,
    action: (user: AuthenticatedUser) => Result,
  ) => Response | Result;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly store: SessionStore;
}
// cpd-ignore-end

function pendingInputResponse(
  dependencies: PendingInputRequestDependencies,
  userId: string,
  sessionId: string,
  result: ReturnType<SessionStore["enqueuePendingInput"]>,
): Response {
  switch (result.status) {
    case "accepted":
    case "duplicate": {
      const detail: AgentSessionDetail | undefined = dependencies.store.get(
        userId,
        sessionId,
      );
      if (detail === undefined) {
        return createApiError("not_found", 404);
      }
      if (result.status === "accepted") {
        dependencies.notify(userId, sessionId);
      }
      return createJsonResponse(
        detail,
        result.status === "accepted" ? 202 : 200,
      );
    }
    case "conflict":
      return createApiError("pending_input_id_conflict", 409);
    case "full":
      return createApiError("pending_input_queue_full", 409);
    case "invalid_state":
      return createApiError("invalid_session_state", 409);
    case "not_found":
      return createApiError("not_found", 404);
  }
}

export function handlePendingInputRequest(
  dependencies: PendingInputRequestDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  return Promise.resolve(
    dependencies.authenticate(request, "POST", async (user) => {
      const input = await parseJsonRequest(request, readPendingInput);
      if (input === undefined) {
        return createApiError("invalid_request", 400);
      }
      return pendingInputResponse(
        dependencies,
        user.id,
        sessionId,
        dependencies.store.enqueuePendingInput(
          user.id,
          sessionId,
          input,
          dependencies.now(),
        ),
      );
    }),
  );
}
