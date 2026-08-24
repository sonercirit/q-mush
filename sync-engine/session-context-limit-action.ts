import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import { SessionContextTokenCapError } from "./session-context-limit-store.ts";
import type { SessionLifecycleDependencies } from "./session-lifecycle-types.ts";
import type { SessionContextTokenCapAction } from "./session-realtime-commands.ts";
import type { SessionStore } from "./session-store.ts";

export function createSessionContextTokenCapAction(
  dependencies: SessionLifecycleDependencies & {
    readonly store: SessionStore;
  },
): SessionContextTokenCapAction {
  return (user, sessionId, userContextTokenCap, workspaceId) => {
    let detail: AgentSessionDetail | undefined;
    try {
      detail = dependencies.store.setContextTokenCap(
        user.id,
        sessionId,
        userContextTokenCap,
        dependencies.now(),
        workspaceId,
      );
    } catch (error) {
      if (!(error instanceof SessionContextTokenCapError)) throw error;
      throw createRealtimeCommandError(
        "invalid_context_token_cap",
        error.message,
      );
    }
    if (detail === undefined) throw createRealtimeCommandError("not_found");
    dependencies.notify(user.id, sessionId);
    return detail;
  };
}
