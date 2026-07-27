import type { ProviderCredentialSource } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionToolsMatch,
  type SessionToolUpdateInput,
  type SessionToolUpdatePreview,
  type SessionToolUpdatePreviewInput,
} from "../shared/session-tool-update.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import { sessionToolCachePreview } from "./session-tool-cache-policy.ts";
import {
  updateStoredSessionTools,
  type SessionToolUpdateStoreOptions,
} from "./session-tool-update-store.ts";

export class SessionToolUpdateError extends RealtimeCommandError {
  constructor(code: string) {
    super(code);
    this.name = "SessionToolUpdateError";
  }
}

export interface SessionToolUpdateDependencies {
  readonly broker: Pick<RunnerCommandBroker, "cancelSessionGeneration">;
  readonly now: () => number;
  readonly readCredentialSource: (
    userId: string,
    detail: AgentSessionDetail,
  ) => Promise<ProviderCredentialSource | undefined>;
  readonly runtimes: Pick<SessionRuntimes, "abortForGeneration">;
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
    throw new SessionToolUpdateError("not_found");
  }
  const credentialSource = await dependencies.readCredentialSource(
    userId,
    detail,
  );
  if (credentialSource === undefined) {
    throw new SessionToolUpdateError("credential_unavailable");
  }
  return {
    detail,
    preview: sessionToolCachePreview(detail, input.tools, {
      credentialSource,
      model: detail.model,
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
    throw new SessionToolUpdateError("stale_generation");
  }
  if (
    preview.cacheDisposition === "warning_required" &&
    !input.confirmedCacheDrop
  ) {
    throw new SessionToolUpdateError("cache_warning_required");
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
    throw new SessionToolUpdateError(
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
