import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import {
  selectedSessionModel,
  type CreateSessionInput,
} from "./session-input.ts";
import type { SessionLauncher } from "./session-launcher.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface SessionCreationDependencies {
  readonly discoverModels: AgentModelDiscoverer;
  readonly launcher: SessionLauncher;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}
// cpd-ignore-end

export async function createValidatedSession(
  dependencies: SessionCreationDependencies,
  user: AuthenticatedUser,
  input: CreateSessionInput,
  credential: ProviderCredentialAccess,
): Promise<Response> {
  const selectedModel = selectedSessionModel(input, credential.source);
  let maxContextTokens: number | null = null;
  let providerPricing: AgentSessionSummary["providerPricing"] = null;
  try {
    // cpd-ignore-start -- Model metadata discovery deliberately mirrors spawned-session discovery.
    const catalog = await dependencies.discoverModels(
      input.provider,
      credential,
    );
    const model = catalog.models.find(({ id }) => id === selectedModel);
    // cpd-ignore-end
    maxContextTokens = model?.contextWindow ?? null;
    providerPricing = model?.pricing ?? null;
  } catch {
    // Model discovery enhances display but does not gate a session.
  }
  if (
    dependencies.runtimes.draining ||
    !dependencies.runtimes.accepts(input.runnerId)
  ) {
    return createApiError("server_restarting", 503);
  }
  const created = dependencies.store.create(
    {
      ...input,
      autoCompact: true,
      maxContextTokens,
      model: selectedModel,
      providerPricing,
      userId: user.id,
    },
    dependencies.now(),
  );
  if (!dependencies.launcher.launch(created, credential, user.id)) {
    // cpd-ignore-start -- Create and queue paths deliberately persist the same launch-race handoff.
    const pending = dependencies.runtimes.pendingRestart(created.runnerId);
    if (pending === undefined) {
      dependencies.store.appendErrorMessage(
        created.id,
        "Session failed: the session could not be launched",
        dependencies.now(),
      );
      dependencies.store.mark(created.id, "failed", dependencies.now());
      dependencies.notify(user.id, created.id);
      return createApiError("session_launch_failed", 500);
    }
    if (
      !dependencies.store.pauseQueuedForRestart(
        created.id,
        pending.requestedBy,
        pending.restartId,
        dependencies.now(),
      )
    ) {
      dependencies.store.mark(created.id, "failed", dependencies.now());
      dependencies.notify(user.id, created.id);
      return createApiError("session_launch_failed", 500);
    }
    dependencies.notify(user.id, created.id);
    return createApiError("server_restarting", 503);
    // cpd-ignore-end
  }
  dependencies.notify(user.id, created.id);
  return createJsonResponse(
    dependencies.store.get(user.id, created.id) ?? created,
    201,
  );
}
