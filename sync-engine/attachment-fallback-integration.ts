import { readOpenRouterProviderRouting } from "../shared/agent-configuration.ts";
import { modelSupportsAttachmentModality } from "../shared/attachment-fallback.ts";
import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import {
  discoverModelOption,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { AttachmentFallbackApi } from "./attachment-fallback-api.ts";
import { AttachmentFallbackStore } from "./attachment-fallback-store.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { SessionCredentialReaders } from "./session-credential-access.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";

export function createAttachmentFallbackIntegration(options: {
  readonly database: AppDatabase;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly generateId: IdGenerator;
  readonly now: () => number;
  readonly providers: SessionCredentialReaders;
  readonly requests: SessionRequestHelpers;
  readonly restartSignal: () => AbortSignal;
}): {
  readonly api: AttachmentFallbackApi;
  readonly store: AttachmentFallbackStore;
} {
  const store = new AttachmentFallbackStore(
    options.database,
    options.generateId,
  );
  const api = new AttachmentFallbackApi({
    now: options.now,
    requests: options.requests,
    store,
    validate: async (user, selection) => {
      const credential = await options.providers[
        selection.provider
      ]?.readCredential(user.id, selection.credentialId, GLOBAL_WORKSPACE_ID);
      if (credential?.id !== selection.credentialId) {
        return false;
      }
      try {
        const model = await discoverModelOption(
          options.discoverModels,
          selection.provider,
          credential,
          selection.model,
          options.restartSignal(),
        );
        if (
          model === undefined ||
          !modelSupportsAttachmentModality(
            model.inputModalities,
            selection.modality,
          )
        ) {
          return false;
        }
        const routing = readOpenRouterProviderRouting(
          selection.openRouterProviderTag,
        );
        if (routing?.type !== "provider") return routing !== undefined;
        const providers = await options.discoverOpenRouterProviders(
          user.id,
          credential,
          selection.model,
          { force: true, signal: options.restartSignal() },
        );
        return providers.providers.some(({ tag }) => tag === routing.tag);
      } catch {
        return false;
      }
    },
  });
  return { api, store };
}
