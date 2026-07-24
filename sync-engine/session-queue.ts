import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import type { PromptInput } from "./session-input.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface SessionQueueDependencies {
  readonly credential: (
    userId: string,
    detail: AgentSessionDetail,
    action: (
      credential: ProviderCredentialAccess,
    ) => Promise<Response> | Response,
  ) => Promise<Response>;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly now: () => number;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}
// cpd-ignore-end

export async function queueSessionForUser(
  dependencies: SessionQueueDependencies,
  user: AuthenticatedUser,
  sessionId: string,
  prompt?: PromptInput,
): Promise<Response> {
  const existing = dependencies.store.get(user.id, sessionId);
  if (!dependencies.runtimes.accepts(existing?.runnerId ?? "")) {
    return createApiError("server_restarting", 503);
  }
  const unavailable = unavailableSessionResponse(existing);
  if (unavailable !== undefined || existing === undefined) {
    return unavailable ?? createApiError("not_found", 404);
  }
  if (!dependencies.runnerIsAvailable(user.id, existing.runnerId)) {
    return createApiError("runner_unavailable", 409);
  }
  return dependencies.credential(user.id, existing, (credential) => {
    const queued = dependencies.store.queue(
      user.id,
      existing.id,
      dependencies.now(),
      prompt === undefined
        ? undefined
        : { content: prompt.prompt, images: prompt.images },
    );
    if (queued.status !== "queued") {
      return createApiError(
        queued.status === "busy" ? "session_busy" : "not_found",
        queued.status === "busy" ? 409 : 404,
      );
    }
    if (!dependencies.launch(queued.detail, credential, user.id)) {
      // cpd-ignore-start -- Create and queue paths deliberately persist the same launch-race handoff.
      const pending = dependencies.runtimes.pendingRestart(
        queued.detail.runnerId,
      );
      if (pending === undefined) {
        dependencies.store.mark(queued.detail.id, "failed", dependencies.now());
        dependencies.notify(user.id, sessionId);
        return createApiError("session_launch_failed", 500);
      }
      if (
        !dependencies.store.pauseQueuedForRestart(
          queued.detail.id,
          pending.requestedBy,
          pending.restartId,
          dependencies.now(),
        )
      ) {
        dependencies.store.mark(queued.detail.id, "failed", dependencies.now());
        dependencies.notify(user.id, sessionId);
        return createApiError("session_launch_failed", 500);
      }
      dependencies.notify(user.id, sessionId);
      return createApiError("server_restarting", 503);
      // cpd-ignore-end
    }
    dependencies.notify(user.id, sessionId);
    const launched =
      dependencies.store.get(user.id, queued.detail.id) ?? queued.detail;
    return createJsonResponse(launched, 202);
  });
}
