import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentModel } from "../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
} from "./agent-compaction.ts";
import type { AgentProviderCredential } from "./agent-model.ts";
import type { RealtimeHub } from "./realtime-hub.ts";

interface AgentModelFactoryOptions extends Pick<
  AgentSessionDetail,
  "model" | "provider" | "providerPricing" | "reasoningEffort" | "tools"
> {
  readonly credential: AgentProviderCredential;
  readonly onDelta?: (delta: {
    readonly content: string;
    readonly reset?: true;
    readonly thinking: string;
  }) => void;
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
    providerPricing: detail.providerPricing,
    reasoningEffort: detail.reasoningEffort,
    systemPrompt,
    tools: detail.tools,
  };
}

export function createSessionAgentModels(options: {
  readonly agentFile: AgentFile | null;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly factory: AgentModelFactory;
  readonly isCurrent: () => boolean;
  readonly realtime: RealtimeHub | undefined;
  readonly userId: string;
}): SessionAgentModels {
  const onDelta: AgentModelFactoryOptions["onDelta"] = (delta) => {
    if (!options.isCurrent()) {
      return;
    }
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
