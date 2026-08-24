import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import { createRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import {
  readSessionCredential,
  type SessionCredentialReaders,
} from "./session-credential-access.ts";
import type { SessionGenerationInterruptionDependencies } from "./session-generation-interruption.ts";
import type { RestartAwareSessionModelDiscoveryDependencies } from "./session-model-discovery-dependencies.ts";
import {
  discoverRequiredSessionMetadata,
  optionalCredentialRejection,
} from "./session-provider-selection.ts";
import { updateStoredSessionProvider } from "./session-provider-update-store.ts";
import {
  captureRestartSignal,
  throwIfServerRestarting,
  withRestartErrorTranslation,
} from "./session-restart-gate.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";

export interface SessionProviderUpdateDependencies
  extends
    RestartAwareSessionModelDiscoveryDependencies,
    SessionGenerationInterruptionDependencies {
  readonly providers: SessionCredentialReaders;
  readonly rejectCredentialErrors?: boolean;
  readonly store: {
    readonly resources: SessionStoreWriteResources;
  };
}

async function targetMetadata(
  dependencies: SessionProviderUpdateDependencies,
  userId: string,
  input: SessionProviderUpdateInput,
  restartSignal: AbortSignal,
  capturedRestartSignal: () => AbortSignal,
) {
  let credential;
  try {
    credential = await readSessionCredential(dependencies.providers, userId, {
      credentialId: input.credentialId,
      provider: input.provider,
      workspaceId: input.workspaceId,
    });
  } catch {
    if (restartSignal.aborted) {
      throwIfServerRestarting(restartSignal);
    }
    throw createRealtimeCommandError("credential_refresh_failed");
  }
  if (credential === undefined) {
    throw createRealtimeCommandError("credential_unavailable");
  }
  return withRestartErrorTranslation(capturedRestartSignal, async (signal) =>
    discoverRequiredSessionMetadata({
      credential,
      dependencies,
      input,
      ownerId: userId,
      signal,
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
    throw createRealtimeCommandError("not_found");
  }
  if (sessionProviderSelectionMatches(existing, input)) {
    return existing;
  }
  if (existing.generation !== input.expectedGeneration) {
    throw createRealtimeCommandError("stale_generation");
  }
  if (!input.confirmedCacheDrop) {
    throw createRealtimeCommandError("cache_warning_required");
  }

  const { read: capturedRestartSignal, signal: restartSignal } =
    captureRestartSignal(dependencies.restartSignal);
  throwIfServerRestarting(restartSignal);
  const metadata = await targetMetadata(
    dependencies,
    userId,
    input,
    restartSignal,
    capturedRestartSignal,
  );
  throwIfServerRestarting(restartSignal);
  const result = updateStoredSessionProvider(dependencies.store.resources, {
    ...input,
    ...metadata,
    now: dependencies.now(),
    userId,
  });
  const detail = result.detail;
  if (result.status === "invalid_context_token_cap") {
    throw createRealtimeCommandError(
      "invalid_context_token_cap",
      result.error ??
        "Lower or clear the context token cap before changing models.",
    );
  }
  if (result.status !== "updated" || detail === undefined) {
    throw createRealtimeCommandError(
      result.status === "not_found" ? "not_found" : "stale_generation",
    );
  }

  const generation = input.expectedGeneration;
  dependencies.runtimes.abortForGeneration(input.sessionId, generation);
  dependencies.broker.cancelSessionGeneration(input.sessionId, generation);
  return detail;
}
