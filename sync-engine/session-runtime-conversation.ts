import { agentCredentialFingerprint } from "./agent-model-options.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export function sessionRuntimeConversation(
  runtime: SessionAgentRuntimeDependencies,
  resolvedModel: string | null | undefined,
): ReturnType<SessionStore["conversation"]> {
  return runtime.store.conversation(
    runtime.detail.id,
    anthropicReplayIdentityFrom({
      credential: runtime.credential,
      credentialFingerprint: agentCredentialFingerprint(runtime.credential),
      model: runtime.detail.model,
      provider: runtime.detail.provider,
      ...(typeof resolvedModel === "string" ? { resolvedModel } : {}),
    }),
    runtime.detail.restartHandoff === null,
  );
}
