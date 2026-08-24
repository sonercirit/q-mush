import type { AgentModelOption } from "../shared/agent-configuration.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { usesAnthropicFormat } from "./agent-model-options.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import type { SessionRuntimeWriter } from "./session-runtime-write.ts";
import type { SessionStore } from "./session-store-interface.ts";
type CurrentModelSource = Pick<
  AttachmentFallbackRuntimeResources,
  "discoverModels"
> & {
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
};

export async function discoverCurrentSessionModel(
  source: CurrentModelSource,
  signal?: AbortSignal,
): Promise<AgentModelOption | undefined> {
  const catalog = await source.discoverModels?.(
    source.detail.provider,
    source.credential,
    signal,
  );
  return catalog?.models.find(({ id }) => id === source.detail.model);
}

interface SessionRequestMetadata {
  readonly adaptiveThinking: boolean | null;
  readonly maxOutputTokens: number | null;
}

type RefreshRuntime = CurrentModelSource & {
  readonly store: Pick<SessionStore, "get" | "setRuntimeModelMetadata">;
  readonly userId: string;
};

// Sessions created before these metadata columns, and sessions reassigned onto
// an Anthropic-format credential, can carry unknown request metadata. Refresh
// both fields from one catalog probe before the first request. Provider failures
// preserve the omissions; a canceled run still rejects promptly.
export async function sessionRequestMetadata(
  runtime: RefreshRuntime,
  write: SessionRuntimeWriter,
  signal?: AbortSignal,
): Promise<SessionRequestMetadata> {
  const liveDetail = runtime.store.get(runtime.userId, runtime.detail.id);
  const liveMetadata = liveDetail ?? runtime.detail;
  const detail = {
    ...runtime.detail,
    adaptiveThinking: liveMetadata.adaptiveThinking,
    maxOutputTokens: liveMetadata.maxOutputTokens,
  };
  const current = {
    adaptiveThinking: detail.adaptiveThinking,
    maxOutputTokens: detail.maxOutputTokens,
  };
  if (
    !usesAnthropicFormat(detail.provider, runtime.credential) ||
    (current.adaptiveThinking !== null && current.maxOutputTokens !== null)
  ) {
    return current;
  }

  let model: AgentModelOption | undefined;
  try {
    model = await discoverCurrentSessionModel({ ...runtime, detail }, signal);
  } catch (error) {
    if (signal?.aborted !== true) return current;
    throw error;
  }
  const refreshed = {
    adaptiveThinking:
      current.adaptiveThinking ?? model?.adaptiveThinking ?? null,
    maxOutputTokens: current.maxOutputTokens ?? model?.maxOutputTokens ?? null,
  };
  const learnsAdaptiveThinking =
    current.adaptiveThinking === null && refreshed.adaptiveThinking !== null;
  const learnsMaxOutputTokens =
    current.maxOutputTokens === null && refreshed.maxOutputTokens !== null;
  if (learnsAdaptiveThinking || learnsMaxOutputTokens) {
    write((sessionId, now, generation) => {
      runtime.store.setRuntimeModelMetadata(
        sessionId,
        runtime.credential.id,
        refreshed,
        now,
        generation,
      );
    });
  }
  return refreshed;
}
