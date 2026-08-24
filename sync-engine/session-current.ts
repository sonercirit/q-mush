import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionStore } from "./session-store-interface.ts";

export function currentStoredSession(
  store: Pick<SessionStore, "get">,
  userId: string,
  detail: Pick<AgentSessionDetail, "id">,
): AgentSessionDetail | undefined {
  return store.get(userId, detail.id);
}
