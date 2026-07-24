import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentModel } from "../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
} from "./agent-compaction.ts";
import type { ChatCompletionsAgentModelOptions } from "./agent-model.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";
import type { RealtimeHub } from "./realtime-hub.ts";

interface AgentModelFactoryOptions
  extends
    Pick<
      ChatCompletionsAgentModelOptions,
      "credential" | "onDelta" | "onTurnStart"
    >,
    Pick<
      AgentSessionDetail,
      "model" | "provider" | "providerPricing" | "reasoningEffort" | "tools"
    > {
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
  onTurnStart?: AgentModelFactoryOptions["onTurnStart"],
): AgentModelFactoryOptions {
  return {
    credential,
    model: detail.model,
    ...(onDelta === undefined ? {} : { onDelta }),
    ...(onTurnStart === undefined ? {} : { onTurnStart }),
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
  readonly id?: () => string;
  readonly realtime: RealtimeHub | undefined;
  readonly streamId?: string;
  readonly toolStream?: {
    provider(delta: NonNullable<ProviderTextDelta["toolCall"]>): void;
    reset(streamId: string): void;
    startTurn(streamId: string): void;
  };
  readonly userId: string;
}): SessionAgentModels {
  const id = options.id ?? createUuidV7;
  let streamId = options.streamId ?? id();
  const startTurn = (): void => {
    streamId = id();
    options.toolStream?.startTurn(streamId);
  };
  const onDelta: AgentModelFactoryOptions["onDelta"] = (delta) => {
    try {
      if (delta.reset === true) {
        streamId = id();
        options.toolStream?.reset(streamId);
      }
      if (delta.toolCall !== undefined) {
        options.toolStream?.provider(delta.toolCall);
      }
      options.realtime?.publishUser(options.userId, {
        content: delta.content,
        ...(delta.reset === true ? { reset: true } : {}),
        sessionId: options.detail.id,
        streamId,
        thinking: delta.thinking,
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
        startTurn,
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
