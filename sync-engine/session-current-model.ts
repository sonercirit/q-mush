import type { AgentModelOption } from "../shared/agent-configuration.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { usesAnthropicFormat } from "./agent-model-options.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import type { SessionStore } from "./session-store.ts";

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

// Sessions predating the max_output_tokens column, and sessions reassigned
// onto an Anthropic-format credential, carry no persisted output limit even
// though Messages requests require max_tokens. Refresh it lazily from the
// catalog before the first request; discovery failures leave the omission
// (permissive proxies accept it, and the model request will surface real
// endpoint errors). Endpoints whose catalog omits the limit re-probe each
// run — the deliberate cost of not persisting a "probed, absent" marker.
type RefreshRuntime = CurrentModelSource & {
  readonly credential: ProviderCredentialAccess;
  readonly store: Pick<SessionStore, "get" | "setRuntimeMaxOutputTokens">;
  readonly userId: string;
};

// runtime.detail is a launch-time snapshot; the live row carries a limit an
// earlier loadModels in this run already persisted, so a two-phase run
// (compact_and_continue) probes the catalog at most once. A missing row
// falls back to the snapshot; a live null stays null (reassignment may have
// cleared it).
export function sessionMaxOutputTokens(
  runtime: RefreshRuntime,
  write: (
    apply: (sessionId: string, now: number, generation: number) => void,
  ) => void,
  signal?: AbortSignal,
): Promise<number | null> {
  const liveDetail = runtime.store.get(runtime.userId, runtime.detail.id);
  const persistedLimit =
    liveDetail === undefined
      ? runtime.detail.maxOutputTokens
      : liveDetail.maxOutputTokens;
  return refreshedMaxOutputTokens(
    {
      ...runtime,
      detail: { ...runtime.detail, maxOutputTokens: persistedLimit },
    },
    signal,
    (value) => {
      write((sessionId, now, generation) => {
        runtime.store.setRuntimeMaxOutputTokens(
          sessionId,
          runtime.credential.id,
          value,
          now,
          generation,
        );
      });
    },
  );
}

async function refreshedMaxOutputTokens(
  source: CurrentModelSource,
  signal: AbortSignal | undefined,
  persist: (maxOutputTokens: number) => void,
): Promise<number | null> {
  if (
    source.detail.maxOutputTokens !== null ||
    !usesAnthropicFormat(source.detail.provider, source.credential)
  ) {
    return source.detail.maxOutputTokens;
  }
  let discovered: number | null;
  try {
    discovered =
      (await discoverCurrentSessionModel(source, signal))?.maxOutputTokens ??
      null;
  } catch (error) {
    // A canceled run must settle promptly instead of reading the omission as
    // "no limit"; only provider failures degrade to it.
    if (signal?.aborted !== true) {
      return null;
    }
    throw error;
  }
  if (discovered !== null) {
    persist(discovered);
  }
  return discovered;
}
