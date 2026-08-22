import type { AgentCredentialRefresher } from "./agent-model-options.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import { createOpenAiSessionCredentialRefresher } from "./session-openai-credential-refresh.ts";

export function runtimeCredentialRefresher(
  runtime: SessionAgentRuntimeDependencies,
): AgentCredentialRefresher | undefined {
  return createOpenAiSessionCredentialRefresher({
    credential: runtime.credential,
    readCredential: runtime.readCredential,
    selection: {
      credentialId: runtime.detail.credentialId,
      provider: runtime.detail.provider,
      workspaceId: runtime.detail.workspaceId,
    },
    userId: runtime.userId,
  });
}
