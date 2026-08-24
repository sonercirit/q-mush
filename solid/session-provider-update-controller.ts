import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  SESSION_MODELS_PATH,
  SESSION_OPENROUTER_PROVIDERS_PATH,
} from "../shared/routes.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  SESSION_PROVIDER_CACHE_WARNING,
  type SessionProviderUpdateSelection,
} from "../shared/session-provider-update.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { WorkspaceSummary } from "../shared/workspace-model.ts";
import { isHttpResponseError, requestJson } from "./browser-http.ts";
import {
  readAgentModelCatalog,
  readOpenRouterProviderCatalog,
  readSessionDetail,
} from "./session-codec.ts";
import type {
  SessionModelDiscoveryFailure,
  SessionModelDiscoveryResult,
} from "./session-model-options.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export async function discoverProviderUpdateModels(
  transport: SessionCommandTransport | undefined,
  provider: ProviderId,
  credentialId: string,
  workspaceId?: WorkspaceSummary["id"],
): Promise<SessionModelDiscoveryResult> {
  try {
    return readAgentModelCatalog(
      transport === undefined
        ? await requestJson(
            `${SESSION_MODELS_PATH}?${new URLSearchParams({
              credentialId,
              provider,
              ...(workspaceId === undefined ? {} : { workspaceId }),
            }).toString()}`,
          )
        : await transport.command(SESSION_REALTIME_OPERATIONS.models, {
            credentialId,
            provider,
          }),
    );
  } catch (error) {
    return modelDiscoveryFailure(provider, error);
  }
}

function modelDiscoveryFailure(
  provider: ProviderId,
  error: unknown,
): SessionModelDiscoveryFailure {
  const providerName = provider === "openrouter" ? "OpenRouter" : "Provider";
  const code =
    isHttpResponseError(error)
      ? error.code
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
        ? error.code
        : undefined;
  if (code === "credential_unavailable") {
    return {
      error: `That ${providerName} credential is not available in this workspace.`,
    };
  }
  if (code === "workspace_unavailable") {
    return { error: "That workspace is unavailable for model discovery." };
  }
  if (
    isHttpResponseError(error) &&
    error.code === "provider_unavailable"
  ) {
    return {
      error: error.detail ?? `${providerName} model discovery is unavailable.`,
    };
  }
  if (code === "provider_unavailable") {
    return { error: `${providerName} model discovery is unavailable.` };
  }
  return { error: `${providerName} model discovery failed. Please try again.` };
}

export async function discoverProviderUpdateProviders(
  credentialId: string,
  model: string,
  workspaceId: string,
): Promise<ReturnType<typeof readOpenRouterProviderCatalog> | undefined> {
  const query = new URLSearchParams({ credentialId, model, workspaceId });
  try {
    const response = await fetch(
      `${SESSION_OPENROUTER_PROVIDERS_PATH}?${query.toString()}`,
    );
    return response.ok
      ? readOpenRouterProviderCatalog(await response.json())
      : undefined;
  } catch {
    return undefined;
  }
}

export async function updateSessionProvider(options: {
  readonly confirmed: boolean;
  readonly detail: AgentSessionDetail;
  readonly selection: SessionProviderUpdateSelection;
  readonly transport: SessionCommandTransport | undefined;
}): Promise<AgentSessionDetail> {
  if (!options.confirmed) {
    throw new Error(SESSION_PROVIDER_CACHE_WARNING);
  }
  if (options.transport === undefined) {
    throw new Error("Realtime provider changes are unavailable");
  }
  return readSessionDetail(
    await options.transport.command(
      SESSION_REALTIME_OPERATIONS.updateProvider,
      {
        confirmedCacheDrop: true,
        expectedGeneration: options.detail.generation,
        sessionId: options.detail.id,
        workspaceId: options.detail.workspaceId,
        ...options.selection,
      },
    ),
  );
}
