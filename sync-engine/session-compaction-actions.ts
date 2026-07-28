import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { withAuthenticatedUser } from "./authenticated-request.ts";
import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import {
  pauseSessionForRestart,
  type SessionLaunchBoundary,
} from "./session-creation.ts";
import type { SessionCredentialOperation } from "./session-credential-operation.ts";
import { queueSessionDetail } from "./session-queue.ts";
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
  readonly requiredWorkspaceId?: string;
  readonly store: SessionStore;
}

export function updateSessionCompactionMode(
  dependencies: SessionCompactionSettingsDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  return Promise.resolve(
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
        dependencies.requiredWorkspaceId,
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

type ManualCompactionCredential = SessionCredentialOperation;

interface ManualCompactionDependencies extends SessionLaunchBoundary {
  readonly credential: ManualCompactionCredential;
  readonly operation: Extract<
    RestartHandoffOperation,
    "compact" | "compact_and_continue"
  >;
  readonly workspaceId?: string;
}

export async function startManualSessionCompaction(
  dependencies: ManualCompactionDependencies,
  user: AuthenticatedUser,
  sessionId: string,
): Promise<Response> {
  if (dependencies.runtimes.draining) {
    return new Response('{"error":"server_restarting"}', {
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 503,
    });
  }
  const existing = dependencies.store.get(
    user.id,
    sessionId,
    dependencies.workspaceId,
  );
  if (existing === undefined) {
    return createApiError("not_found", 404);
  }
  if (
    dependencies.operation === "compact_and_continue" &&
    existing.status !== "idle"
  ) {
    return createApiError("session_busy", 409);
  }
  if (existing.runnerRequired) {
    return createApiError("runner_required", 409);
  }
  if (
    existing.status === "paused" ||
    existing.status === "queued" ||
    existing.status === "running"
  ) {
    return createApiError("session_busy", 409);
  }

  return dependencies.credential(user.id, existing, (credential) => {
    const queued = queueSessionDetail(dependencies, [
      user.id,
      sessionId,
      undefined,
      dependencies.workspaceId,
    ]);
    if (queued instanceof Response) {
      return queued;
    }

    if (
      !dependencies.launch(queued, credential, user.id, dependencies.operation)
    ) {
      if (
        pauseSessionForRestart(dependencies, queued, dependencies.operation)
      ) {
        dependencies.notify(user.id, queued.id);
        return createApiError("server_restarting", 503);
      }
      dependencies.store.transitionRuntime(
        queued.id,
        "failed",
        dependencies.now(),
        queued.generation,
      );
      dependencies.notify(user.id, queued.id);
      return createApiError("session_launch_failed", 500);
    }
    const notify = withUserNotification(dependencies, user.id, queued.id);
    queueMicrotask(notify);
    return createJsonResponse(queued, 202);
  });
}
