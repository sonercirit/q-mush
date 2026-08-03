import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentModel } from "../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { ModelConversationCompactor } from "./agent-compaction.ts";
import {
  agentModelOpenRouterProviderRouting,
  type AgentModelRequestOptions,
} from "./agent-model-options.ts";
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
  readonly publishCompactionSettled: () => void;
}

function agentModelRoutingOptions(
  selection: string | null | undefined,
): Pick<
  AgentModelRequestOptions,
  "openRouterProviderRouting" | "openRouterProviderTag"
> {
  const routing = agentModelOpenRouterProviderRouting(selection);
  if (routing?.type === "provider") {
    return {
      openRouterProviderRouting: routing,
      openRouterProviderTag: routing.tag,
    };
  }
  return routing === undefined ? {} : { openRouterProviderRouting: routing };
}

export function createFallbackModel(
  factory: AgentModelFactory,
  selection: {
    readonly credential: ProviderCredentialAccess;
    readonly model: string;
    readonly openRouterProviderTag?: string | null;
    readonly prompt: string | null;
    readonly provider: ProviderId;
    readonly providerPricing: ProviderModelPricing | null;
  },
): AgentModel {
  return factory({
    credential: selection.credential,
    model: selection.model,
    ...agentModelRoutingOptions(selection.openRouterProviderTag),
    provider: selection.provider,
    providerPricing: selection.providerPricing,
    systemPrompt:
      selection.prompt ??
      "Describe the supplied attachment faithfully for another text-only model. Return only the useful textual result.",
    tools: [],
  });
}

function modelOptions(
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  systemPrompt: string,
  onDelta?: AgentModelFactoryOptions["onDelta"],
  onStepStart?: AgentModelFactoryOptions["onStepStart"],
): AgentModelFactoryOptions {
  return {
    credential,
    ...(sessionToolCacheCapability({
      credentialSource: credential.source,
      provider: detail.provider,
      tools: detail.tools,
    }).preservesDynamicToolCache
      ? { dynamicToolCache: true }
      : {}),
    model: detail.model,
    ...agentModelRoutingOptions(detail.openRouterProviderTag),
    ...(onDelta === undefined ? {} : { onDelta }),
    ...(onStepStart === undefined ? {} : { onStepStart }),
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
  const startStep = (): void => {
    streamId = id();
    options.toolStream?.startStep(streamId);
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
      // Live delivery must never interrupt the persisted model step.
    }
  };
  const systemPrompt = createAgentSystemPrompt(
    options.agentFile,
    options.detail.executionEnvironment,
  );
  const publishCompaction = (
    event:
      | { readonly content: string; readonly type: "request" }
      | { readonly type: "settled" },
  ): void => {
    if (!options.isCurrent()) {
      return;
    }
    try {
      options.realtime?.publishUser(
        options.userId,
        event.type === "request"
          ? {
              content: event.content,
              sessionId: options.detail.id,
              streamId,
              type: "session_compaction_request",
            }
          : {
              sessionId: options.detail.id,
              type: "session_compaction_settled",
            },
        options.detail.workspaceId,
      );
    } catch {
      // Live delivery must never interrupt the persisted model step.
    }
  };
  const publishCompactionRequest = (content: string): void => {
    publishCompaction({ content, type: "request" });
  };
  const publishCompactionSettled = (): void => {
    publishCompaction({ type: "settled" });
  };
  return {
    agent: options.factory(
      modelOptions(
        options.detail,
        options.credential,
        systemPrompt,
        onDelta,
        startStep,
      ),
    ),
    createCompactor: () => {
      streamId = id();
      return new ModelConversationCompactor(
        options.factory(
          modelOptions(
            options.detail,
            options.credential,
            systemPrompt,
            onDelta,
          ),
        ),
        publishCompactionRequest,
      );
    },
    publishCompactionSettled,
  };
}
