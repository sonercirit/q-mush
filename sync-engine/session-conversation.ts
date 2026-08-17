import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { agentCredentialFingerprint } from "./agent-model-options.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import type { SessionStore } from "./session-store.ts";

export function readSessionConversation(
  runtime: {
    readonly credential: ProviderCredentialAccess;
    readonly detail: AgentSessionDetail;
    readonly store: Pick<SessionStore, "conversation">;
  },
  resolvedModel?: string,
) {
  const { credential, detail } = runtime;
  const identity = anthropicReplayIdentityFrom({
    credential,
    credentialFingerprint: agentCredentialFingerprint(credential),
    model: detail.model,
    provider: detail.provider,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
  });
  return runtime.store.conversation(
    detail.id,
    identity,
    detail.restartHandoff === null,
  );
}
