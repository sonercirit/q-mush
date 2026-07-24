import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

function readCompactionMode(value: unknown): boolean | undefined {
  return typeof value === "object" &&
    value !== null &&
    "autoCompact" in value &&
    typeof value.autoCompact === "boolean"
    ? value.autoCompact
    : undefined;
}

function withUserNotification(
  dependencies: {
    readonly notify: (userId: string, sessionId: string) => void;
  },
  userId: string,
  sessionId: string,
): () => void {
  return () => {
    dependencies.notify(userId, sessionId);
  };
}

interface SessionCompactionSettingsDependencies {
  readonly auth: GoogleAuth;
  readonly now: () => number;
  readonly onChanged: (detail: AgentSessionDetail, userId: string) => void;
  readonly store: SessionStore;
}

export async function updateSessionCompactionMode(
  dependencies: SessionCompactionSettingsDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return createMethodNotAllowedResponse("POST");
  }
  return await Promise.resolve(
    withAuthenticatedUser(dependencies.auth, request, async (user) => {
      const autoCompact = await parseJsonRequest(request, readCompactionMode);
      if (autoCompact === undefined) {
        return createApiError("invalid_request", 400);
      }
      const detail = dependencies.store.setAutoCompact(
        user.id,
        sessionId,
        autoCompact,
        dependencies.now(),
      );
      if (detail !== undefined) {
        dependencies.onChanged(detail, user.id);
      }
      return detail === undefined
        ? createApiError("not_found", 404)
        : createJsonResponse(detail);
    }),
  );
}

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface ManualCompactionDependencies {
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
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}
// cpd-ignore-end

function restartingResponse(): Response {
  return createApiError("server_restarting", 503);
}

export async function startManualSessionCompaction(
  // cpd-ignore-start -- Queueing manual compaction deliberately mirrors session queueing.
  dependencies: ManualCompactionDependencies,
  user: AuthenticatedUser,
  sessionId: string,
): Promise<Response> {
  const existing = dependencies.store.get(user.id, sessionId);
  if (
    dependencies.runtimes.draining ||
    (existing !== undefined &&
      !dependencies.runtimes.accepts(existing.runnerId))
  ) {
    return restartingResponse();
  }
  if (existing === undefined) {
    return createApiError("not_found", 404);
  }
  if (
    existing.status === "queued" ||
    existing.status === "running" ||
    existing.status === "paused"
  ) {
    return createApiError("session_busy", 409);
  }

  return dependencies.credential(user.id, existing, (credential) => {
    const queued = dependencies.store.queue(
      user.id,
      sessionId,
      dependencies.now(),
    );
    if (queued.status !== "queued") {
      return createApiError("session_busy", 409);
    }

    if (!dependencies.launch(queued.detail, credential, user.id)) {
      const restart = dependencies.runtimes.pendingRestart(
        queued.detail.runnerId,
      );
      if (restart !== undefined) {
        if (
          !dependencies.store.pauseQueuedForRestart(
            queued.detail.id,
            restart.requestedBy,
            restart.restartId,
            dependencies.now(),
          )
        ) {
          dependencies.store.mark(
            queued.detail.id,
            "failed",
            dependencies.now(),
          );
          dependencies.notify(user.id, queued.detail.id);
          return createApiError("session_launch_failed", 500);
        }
        dependencies.notify(user.id, queued.detail.id);
        return restartingResponse();
      }
      dependencies.store.mark(queued.detail.id, "failed", dependencies.now());
      dependencies.notify(user.id, queued.detail.id);
      return createApiError("session_launch_failed", 500);
    }
    const notify = withUserNotification(
      dependencies,
      user.id,
      queued.detail.id,
    );
    queueMicrotask(notify);
    return createJsonResponse(queued.detail, 202);
  });
  // cpd-ignore-end
}
