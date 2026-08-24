import type { ProviderCredentialSource } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionToolsMatch,
  type SessionToolUpdateInput,
  type SessionToolUpdatePreview,
  type SessionToolUpdatePreviewInput,
} from "../shared/session-tool-update.ts";
import { createTaggedRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { SessionGenerationInterruptionDependencies } from "./session-generation-interruption.ts";
import { sessionToolCachePreview } from "./session-tool-cache-policy.ts";
import {
  updateStoredSessionTools,
  type SessionToolUpdateStoreOptions,
} from "./session-tool-update-store.ts";

export type SessionToolUpdateError = ReturnType<
  typeof createSessionToolUpdateError
>;

function createSessionToolUpdateError(code: string) {
  return createTaggedRealtimeCommandError(
    code,
    undefined,
    "session_tool_update_error",
    "SessionToolUpdateError",
  );
}

export function isSessionToolUpdateError(
  error: unknown,
): error is SessionToolUpdateError {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "session_tool_update_error"
  );
}

export interface SessionToolUpdateDependencies extends SessionGenerationInterruptionDependencies {
  readonly readCredentialSource: (
    userId: string,
    detail: AgentSessionDetail,
  ) => Promise<ProviderCredentialSource | undefined>;
  readonly store: SessionToolUpdateStoreOptions;
}

async function previewFor(
  dependencies: SessionToolUpdateDependencies,
  userId: string,
  input: SessionToolUpdatePreviewInput,
): Promise<{
  readonly detail: AgentSessionDetail;
  readonly preview: SessionToolUpdatePreview;
}> {
  const detail = dependencies.store.read(
    userId,
    input.sessionId,
    input.workspaceId,
  );
  if (detail === undefined) {
    throw createSessionToolUpdateError("not_found");
  }
  const credentialSource = await dependencies.readCredentialSource(
    userId,
    detail,
  );
  if (credentialSource === undefined) {
    throw createSessionToolUpdateError("credential_unavailable");
  }
  return {
    detail,
    preview: sessionToolCachePreview(detail, input.tools, {
      credentialSource,
      provider: detail.provider,
      tools: input.tools,
    }),
  };
}

export async function previewSessionToolUpdate(
  dependencies: SessionToolUpdateDependencies,
  userId: string,
  input: SessionToolUpdatePreviewInput,
): Promise<SessionToolUpdatePreview> {
  return (await previewFor(dependencies, userId, input)).preview;
}

export async function applySessionToolUpdate(
  dependencies: SessionToolUpdateDependencies,
  userId: string,
  input: SessionToolUpdateInput,
): Promise<AgentSessionDetail> {
  const { detail, preview } = await previewFor(dependencies, userId, input);
  if (detail.generation !== input.expectedGeneration) {
    throw createSessionToolUpdateError("stale_generation");
  }
  if (
    preview.cacheDisposition === "warning_required" &&
    !input.confirmedCacheDrop
  ) {
    throw createSessionToolUpdateError("cache_warning_required");
  }
  if (sessionToolsMatch(detail.tools, input.tools)) {
    return detail;
  }

  const result = updateStoredSessionTools(dependencies.store, {
    expectedGeneration: input.expectedGeneration,
    now: dependencies.now(),
    sessionId: input.sessionId,
    tools: input.tools,
    userId,
    workspaceId: input.workspaceId,
  });
  if (result.status !== "updated") {
    throw createSessionToolUpdateError(
      result.status === "not_found" ? "not_found" : "stale_generation",
    );
  }

  // The committed generation is authoritative before local cancellation. A
  // queued/in-flight command therefore fails its authorize callback even if a
  // best-effort runner cancellation races with execution.
  dependencies.runtimes.abortForGeneration(
    input.sessionId,
    input.expectedGeneration,
  );
  dependencies.broker.cancelSessionGeneration(
    input.sessionId,
    input.expectedGeneration,
  );
  return result.detail;
}
