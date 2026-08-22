import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export function sessionRuntimeConversation(
  runtime: SessionAgentRuntimeDependencies,
): ReturnType<SessionStore["conversation"]> {
  return runtime.store.conversation(
    runtime.detail.id,
    runtime.detail.restartHandoff === null,
  );
}
