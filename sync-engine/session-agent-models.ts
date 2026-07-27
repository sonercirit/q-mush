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
import type { AgentModelRequestOptions } from "./agent-model-options.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { sessionToolCacheCapability } from "./session-tool-capability.ts";
import type { ToolStreamPublisher } from "./tool-stream-publisher.ts";

interface AgentModelFactoryOptions
  extends
    AgentModelRequestOptions,
    Pick<AgentSessionDetail, "providerPricing"> {
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
    ...(sessionToolCacheCapability({
      credentialSource: credential.source,
      model: detail.model,
      provider: detail.provider,
      tools: detail.tools,
    }).preservesDynamicToolCache
      ? { dynamicToolCache: true }
      : {}),
    model: detail.model,
    ...(detail.openRouterProviderTag === null
      ? {}
      : { openRouterProviderTag: detail.openRouterProviderTag }),
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
  readonly isCurrent: () => boolean;
  readonly realtime: RealtimeHub | undefined;
  readonly streamId?: string;
  readonly toolStream?: ToolStreamPublisher;
  readonly userId: string;
}): SessionAgentModels {
  const id = options.id ?? createUuidV7;
  let streamId = options.streamId ?? id();
  const startTurn = (): void => {
    streamId = id();
    options.toolStream?.startTurn(streamId);
  };
  const onDelta: AgentModelFactoryOptions["onDelta"] = (delta) => {
    if (!options.isCurrent()) {
      return;
    }
    try {
      if (delta.reset === true) {
        streamId = id();
        options.toolStream?.reset(streamId);
      }
      if (delta.toolCall !== undefined) {
        options.toolStream?.provider(delta.toolCall);
      }
      options.realtime?.publishUser(
        options.userId,
        {
          content: delta.content,
          ...(delta.reset === true ? { reset: true } : {}),
          sessionId: options.detail.id,
          streamId,
          thinking: delta.thinking,
          type: "session_delta",
        },
        options.detail.workspaceId,
      );
    } catch {
      // Live delivery must never interrupt the persisted model turn.
    }
  };
  return {
    agent: options.factory(
      modelOptions(
        options.detail,
        options.credential,
        createAgentSystemPrompt(
          options.agentFile,
          options.detail.executionEnvironment,
        ),
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
