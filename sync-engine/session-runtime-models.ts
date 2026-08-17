import type { AgentCredentialRefresher } from "./agent-model-options.ts";
import {
  createSessionAgentModels,
  type SessionAgentModels,
} from "./session-agent-models.ts";
import { sessionModelContextOptions } from "./session-model-context-options.ts";
import {
  createOpenAiSessionCredentialRefresher,
  type OpenAiCredentialRefreshOptions,
} from "./session-openai-credential-refresh.ts";
import type { RuntimeSessionAgentModelOptions } from "./session-runtime-model-options.ts";

export interface RuntimeSessionAgentModels extends SessionAgentModels {
  readonly attachmentRefreshCredential: AgentCredentialRefresher | undefined;
}

function runtimeCredentialRefresherOptions(
  options: RuntimeSessionAgentModelOptions,
): OpenAiCredentialRefreshOptions {
  return {
    credential: options.credential,
    readCredential: options.readCredential,
    selection: {
      credentialId: options.detail.credentialId,
      provider: options.detail.provider,
      workspaceId: options.detail.workspaceId,
    },
    userId: options.userId,
  };
}

export function createRuntimeSessionAgentModels(
  options: RuntimeSessionAgentModelOptions,
): RuntimeSessionAgentModels {
  const refreshCredential = createOpenAiSessionCredentialRefresher(
    runtimeCredentialRefresherOptions(options),
  );
  const models = createSessionAgentModels({
    ...sessionModelContextOptions(options),
    factory: options.factory,
    onStepStart: options.markStepStart,
    ...(refreshCredential === undefined ? {} : { refreshCredential }),
  });
  return { ...models, attachmentRefreshCredential: refreshCredential };
}
