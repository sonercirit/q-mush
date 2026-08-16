import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import type { SessionStore } from "./session-store.ts";

export function readSessionConversation(runtime: {
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly store: Pick<SessionStore, "conversation">;
}) {
  const { credential, detail } = runtime;
  const identity = anthropicReplayIdentityFrom({
    credential,
    credentialFingerprint: credential.credentialFingerprint,
    model: detail.model,
    provider: detail.provider,
  });
  return runtime.store.conversation(
    detail.id,
    identity,
    detail.restartHandoff === null,
  );
}
