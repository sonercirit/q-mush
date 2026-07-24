import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";

interface SessionReader {
  get(userId: string, sessionId: string): AgentSessionDetail | undefined;
}

export function storedSessionResponse(
  store: SessionReader,
  userId: string,
  sessionId: string,
): Response {
  const detail = store.get(userId, sessionId);
  return detail === undefined
    ? createApiError("not_found", 404)
    : createJsonResponse(detail);
}

export function withStoredSession<Result>(
  store: SessionReader,
  userId: string,
  sessionId: string,
  action: (session: AgentSessionDetail) => Result,
): Result | Response {
  const session = store.get(userId, sessionId);
  return session === undefined
    ? createApiError("not_found", 404)
    : action(session);
}
