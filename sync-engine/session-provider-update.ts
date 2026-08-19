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
import {
  optionalCredentialRejection,
  requireSessionMetadata,
  sessionMetadataFromDependencies,
} from "./session-provider-selection.ts";
import { updateStoredSessionProvider } from "./session-provider-update-store.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";

export interface SessionProviderUpdateDependencies {
  readonly broker: Pick<RunnerCommandBroker, "cancelSessionGeneration">;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly now: () => number;
  readonly providers: SessionCredentialReaders;
  readonly rejectCredentialErrors?: boolean;
  readonly runtimes: Pick<SessionRuntimes, "abortForGeneration">;
  readonly store: {
    readonly resources: SessionStoreWriteResources;
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
  return requireSessionMetadata(
    await sessionMetadataFromDependencies({
      credential,
      dependencies,
      input,
      ownerId: userId,
      ...optionalCredentialRejection(dependencies.rejectCredentialErrors),
    }),
  );
}

export async function applySessionProviderUpdate(
  dependencies: SessionProviderUpdateDependencies,
  userId: string,
  input: SessionProviderUpdateInput,
): Promise<AgentSessionDetail> {
  const existing = dependencies.store.resources.read(
    userId,
    input.sessionId,
    input.workspaceId,
  );
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
  const result = updateStoredSessionProvider(dependencies.store.resources, {
    ...input,
    ...metadata,
    now: dependencies.now(),
    userId,
  });
  const detail = result.detail;
  if (result.status === "invalid_context_token_cap") {
    throw new RealtimeCommandError(
      "invalid_context_token_cap",
      result.error ??
        "Lower or clear the context token cap before changing models.",
    );
  }
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
