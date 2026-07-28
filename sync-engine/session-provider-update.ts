import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import {
  readSessionCredential,
  type SessionCredentialReaders,
} from "./session-credential-access.ts";
import { sessionMetadata } from "./session-provider-selection.ts";
import { updateStoredSessionProvider } from "./session-provider-update-store.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

export interface SessionProviderUpdateDependencies {
  readonly broker: Pick<RunnerCommandBroker, "cancelSessionGeneration">;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly now: () => number;
  readonly providers: SessionCredentialReaders;
  readonly runtimes: Pick<SessionRuntimes, "abortForGeneration">;
  readonly store: {
    readonly database: Parameters<typeof updateStoredSessionProvider>[0];
    readonly read: (
      identity: readonly [
        userId: string,
        sessionId: string,
        workspaceId: string,
      ],
    ) => AgentSessionDetail | undefined;
  };
}

async function targetMetadata(
  dependencies: SessionProviderUpdateDependencies,
  userId: string,
  input: SessionProviderUpdateInput,
) {
  let credential;
  try {
    credential = await readSessionCredential(dependencies.providers, userId, {
      credentialId: input.credentialId,
      provider: input.provider,
      workspaceId: input.workspaceId,
    });
  } catch {
    throw new RealtimeCommandError("credential_refresh_failed");
  }
  if (credential === undefined) {
    throw new RealtimeCommandError("credential_unavailable");
  }
  const metadata = await sessionMetadata({
    discoverModels: dependencies.discoverModels,
    input,
    credential,
    ownerId: userId,
    discoverProviders: dependencies.discoverOpenRouterProviders,
  });
  if ("error" in metadata) {
    throw new RealtimeCommandError(
      metadata.error === "provider_unavailable"
        ? "openrouter_provider_unavailable"
        : "openrouter_provider_validation_failed",
    );
  }
  return metadata;
}

export async function applySessionProviderUpdate(
  dependencies: SessionProviderUpdateDependencies,
  userId: string,
  input: SessionProviderUpdateInput,
): Promise<AgentSessionDetail> {
  const existing = dependencies.store.read([
    userId,
    input.sessionId,
    input.workspaceId,
  ]);
  if (existing === undefined) {
    throw new RealtimeCommandError("not_found");
  }
  if (sessionProviderSelectionMatches(existing, input)) {
    return existing;
  }
  if (existing.generation !== input.expectedGeneration) {
    throw new RealtimeCommandError("stale_generation");
  }
  if (!input.confirmedCacheDrop) {
    throw new RealtimeCommandError("cache_warning_required");
  }

  const metadata = await targetMetadata(dependencies, userId, input);
  const result = updateStoredSessionProvider(
    dependencies.store.database,
    dependencies.store.read,
    {
      ...input,
      ...metadata,
      now: dependencies.now(),
      userId,
    },
  );
  const detail = result.detail;
  if (result.status !== "updated" || detail === undefined) {
    throw new RealtimeCommandError(
      result.status === "not_found" ? "not_found" : "stale_generation",
    );
  }

  const generation = input.expectedGeneration;
  dependencies.runtimes.abortForGeneration(input.sessionId, generation);
  dependencies.broker.cancelSessionGeneration(input.sessionId, generation);
  return detail;
}
