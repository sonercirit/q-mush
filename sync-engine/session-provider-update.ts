import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
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
  restartSignalIsAborted,
  throwIfServerRestarting,
  withRestartErrorTranslation,
} from "./session-restart-gate.ts";

export interface SessionProviderUpdateDependencies
  extends
    RestartAwareSessionModelDiscoveryDependencies,
    SessionGenerationInterruptionDependencies {
  readonly providers: SessionCredentialReaders;
  readonly rejectCredentialErrors?: boolean;
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
    if (restartSignalIsAborted(dependencies.restartSignal)) {
      throwIfServerRestarting(dependencies.restartSignal());
    }
    throw new RealtimeCommandError("credential_refresh_failed");
  }
  if (credential === undefined) {
    throw new RealtimeCommandError("credential_unavailable");
  }
  return withRestartErrorTranslation(
    dependencies.restartSignal,
    async (signal) =>
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

  throwIfServerRestarting(dependencies.restartSignal());
  const metadata = await targetMetadata(dependencies, userId, input);
  throwIfServerRestarting(dependencies.restartSignal());
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
