import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";

export function readStoredSessionResult<Status extends string>(
  resources: Pick<SessionStoreWriteResources, "read">,
  userId: string,
  sessionId: string,
  status: Status,
  missingMessage: string,
): { readonly detail: AgentSessionDetail; readonly status: Status } {
  const detail = resources.read(userId, sessionId);
  if (detail === undefined) {
    throw new Error(missingMessage);
  }
  return { detail, status };
}
