import { agentCredentialFingerprint } from "./agent-model-options.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export function sessionRuntimeConversation(
  runtime: SessionAgentRuntimeDependencies,
): ReturnType<SessionStore["conversation"]> {
  return runtime.store.conversation(
    runtime.detail.id,
    anthropicReplayIdentityFrom({
      credential: runtime.credential,
      credentialFingerprint: agentCredentialFingerprint(runtime.credential),
      model: runtime.detail.model,
      provider: runtime.detail.provider,
    }),
    runtime.detail.restartHandoff === null,
  );
}
