import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
} from "./agent-compaction.ts";
import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type { AgentFile } from "./agent-file.ts";
import type { AgentModel } from "./agent-loop.ts";
import type { AgentProviderCredential } from "./agent-model.ts";
import { createAgentSystemPrompt } from "./agent-prompt.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "./provider-credential-store.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { AgentSessionDetail } from "./session-model.ts";

interface AgentModelFactoryOptions {
  readonly credential: AgentProviderCredential;
  readonly model: string;
  readonly onDelta?: (delta: {
    readonly content: string;
    readonly thinking: string;
  }) => void;
  readonly provider: ProviderId;
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly systemPrompt: string;
}

export type AgentModelFactory = (
  options: AgentModelFactoryOptions,
) => AgentModel;

export interface SessionAgentModels {
  readonly agent: AgentModel;
  readonly createCompactor: () => ModelConversationCompactor;
}

function modelOptions(
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  systemPrompt: string,
  onDelta?: AgentModelFactoryOptions["onDelta"],
): AgentModelFactoryOptions {
  return {
    credential,
    model: detail.model,
    ...(onDelta === undefined ? {} : { onDelta }),
    provider: detail.provider,
    reasoningEffort: detail.reasoningEffort,
    systemPrompt,
  };
}

export function createSessionAgentModels(options: {
  readonly agentFile: AgentFile | null;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly factory: AgentModelFactory;
  readonly realtime: RealtimeHub | undefined;
  readonly userId: string;
}): SessionAgentModels {
  const onDelta: AgentModelFactoryOptions["onDelta"] = (delta) => {
    try {
      options.realtime?.publishUser(options.userId, {
        ...delta,
        sessionId: options.detail.id,
        type: "session_delta",
      });
    } catch {
      // Live delivery must never interrupt the persisted model turn.
    }
  };
  return {
    agent: options.factory(
      modelOptions(
        options.detail,
        options.credential,
        createAgentSystemPrompt(options.agentFile),
        onDelta,
      ),
    ),
    createCompactor: () =>
      new ModelConversationCompactor(
        options.factory(
          modelOptions(
            options.detail,
            options.credential,
            AGENT_COMPACTION_SYSTEM_PROMPT,
          ),
        ),
      ),
  };
}
