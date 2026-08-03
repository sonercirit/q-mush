import type { AgentSessionDetail } from "../shared/session-model.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
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
      throw new RealtimeCommandError(
        "invalid_context_token_cap",
        error instanceof Error
          ? error.message
          : "The context token cap is invalid.",
      );
    }
    if (detail === undefined) throw new RealtimeCommandError("not_found");
    dependencies.notify(user.id, sessionId);
    return detail;
  };
}
