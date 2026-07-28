import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../shared/routes.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  SESSION_PROVIDER_CACHE_WARNING,
  type SessionProviderUpdateSelection,
} from "../shared/session-provider-update.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import {
  readAgentModelCatalog,
  readOpenRouterProviderCatalog,
  readSessionDetail,
} from "./session-codec.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export async function discoverProviderUpdateModels(
  transport: SessionCommandTransport | undefined,
  provider: ProviderId,
  credentialId: string,
): Promise<AgentModelCatalog | undefined> {
  if (transport === undefined) {
    return undefined;
  }
  try {
    return readAgentModelCatalog(
      await transport.command(SESSION_REALTIME_OPERATIONS.models, {
        credentialId,
        provider,
      }),
    );
  } catch {
    return undefined;
  }
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
