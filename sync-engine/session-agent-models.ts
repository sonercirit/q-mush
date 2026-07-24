import type { AgentFile } from "../shared/agent-file.ts";
import { isAbortError, type AgentModel } from "../shared/agent-loop.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import type { SessionCompactionRealtimeEvent } from "../shared/compaction-realtime.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  AGENT_COMPACTION_SYSTEM_PROMPT,
  ModelConversationCompactor,
  type AgentConversationCompaction,
} from "./agent-compaction.ts";
import type { AgentProviderCredential } from "./agent-model.ts";
import {
  createCompactionRealtimeLifecycle,
  type CompactionDeltaListener,
} from "./compaction-realtime.ts";
import type { RealtimeHub } from "./realtime-hub.ts";

interface AgentModelFactoryOptions extends Pick<
  AgentSessionDetail,
  "model" | "provider" | "providerPricing" | "reasoningEffort" | "tools"
> {
  readonly credential: AgentProviderCredential;
  readonly onDelta?: CompactionDeltaListener;
  readonly systemPrompt: string;
}

export type AgentModelFactory = (
  options: AgentModelFactoryOptions,
) => AgentModel;

export interface SessionAgentModels {
  readonly agent: AgentModel;
  readonly createCompactor: () => AgentConversationCompaction;
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

function failLifecycle(
  lifecycle: ReturnType<typeof createCompactionRealtimeLifecycle>,
  error: unknown,
  signal?: AbortSignal,
): void {
  if (signal?.aborted === true || isAbortError(error)) {
    lifecycle.cancel();
  } else {
    lifecycle.fail();
  }
}

export function createSessionAgentModels(options: {
  readonly agentFile: AgentFile | null;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly factory: AgentModelFactory;
  readonly operationId?: () => string;
  readonly realtime: Pick<RealtimeHub, "publishUser"> | undefined;
  readonly userId: string;
}): SessionAgentModels {
  const publish = (payload: Readonly<Record<string, unknown>>): void => {
    options.realtime?.publishUser(options.userId, payload);
  };
  const publishSafely = (payload: Readonly<Record<string, unknown>>): void => {
    try {
      publish(payload);
    } catch {
      // Live delivery must never interrupt the persisted model turn.
    }
  };
  const ordinaryDelta: AgentModelFactoryOptions["onDelta"] = (delta) => {
    publishSafely({
      ...delta,
      sessionId: options.detail.id,
      type: "session_delta",
    });
  };
  const operationId = options.operationId ?? createUuidV7;

  return {
    agent: options.factory(
      modelOptions(
        options.detail,
        options.credential,
        createAgentSystemPrompt(options.agentFile),
        ordinaryDelta,
      ),
    ),
    createCompactor: () => {
      let deliveryFailed = false;
      const state: {
        lifecycle:
          ReturnType<typeof createCompactionRealtimeLifecycle> | undefined;
      } = { lifecycle: undefined };
      const publishCompaction = (
        event: SessionCompactionRealtimeEvent,
      ): void => {
        if (deliveryFailed) {
          return;
        }
        try {
          publish({ ...event });
        } catch {
          deliveryFailed = true;
          if (
            event.phase !== "cancel" &&
            event.phase !== "complete" &&
            event.phase !== "failure"
          ) {
            state.lifecycle?.fail();
          }
        }
      };
      const lifecycle = createCompactionRealtimeLifecycle({
        listener: publishCompaction,
        operationId: operationId(),
        sessionId: options.detail.id,
      });
      state.lifecycle = lifecycle;
      const compactor = new ModelConversationCompactor(
        options.factory(
          modelOptions(
            options.detail,
            options.credential,
            AGENT_COMPACTION_SYSTEM_PROMPT,
            lifecycle.onDelta,
          ),
        ),
      );
      return {
        compact: async (...parameters) => {
          lifecycle.start();
          try {
            return await compactor.compact(...parameters);
          } catch (error) {
            failLifecycle(lifecycle, error, parameters[1]);
            throw error;
          }
        },
        complete: () => {
          lifecycle.complete();
        },
        fail: (error, signal) => {
          failLifecycle(lifecycle, error, signal);
        },
      };
    },
  };
}
