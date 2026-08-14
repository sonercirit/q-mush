import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { anthropicReplayIdentity } from "./anthropic-replay-identity.ts";
import type { SessionStore } from "./session-store.ts";

export function readSessionConversation(runtime: {
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly store: Pick<SessionStore, "conversation" | "credentialFingerprint">;
}) {
  const { detail } = runtime;
  const credentialFingerprint = runtime.store.credentialFingerprint(
    detail.credentialId,
  );
  if (credentialFingerprint === undefined) {
    throw new Error("The provider credential is no longer available");
  }
  const identity = anthropicReplayIdentity(
    detail.provider,
    runtime.credential,
    detail.model,
    credentialFingerprint,
  );
  return runtime.store.conversation(
    detail.id,
    identity,
    detail.restartHandoff === null,
  );
}
