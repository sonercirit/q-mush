import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import {
  queueFailureResponse,
  unavailableSessionResponse,
} from "./session-availability.ts";
import {
  failedSessionLaunchResponse,
  type SessionLaunchBoundary,
} from "./session-creation.ts";
import type { SessionCredentialOperation } from "./session-credential-operation.ts";
import type { PromptInput } from "./session-input.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";
import type { QueueSessionResult } from "./session-store-queue.ts";

export interface SessionQueueDependencies extends SessionLaunchBoundary {
  readonly credential: SessionCredentialOperation;
  readonly runnerIsAvailable: SessionRunnerAvailability;
  readonly workspaceId?: string;
}

function queueSession(
  dependencies: Pick<SessionQueueDependencies, "now" | "store">,
  userId: string,
  sessionId: string,
  prompt?: PromptInput,
  workspaceId?: string,
): QueueSessionResult {
  return dependencies.store.queue(
    userId,
    sessionId,
    dependencies.now(),
    prompt === undefined
      ? undefined
      : {
          content: prompt.prompt,
          images: prompt.attachments ?? prompt.images,
        },
    undefined,
    workspaceId,
  );
}

function queuedSessionDetail(
  result: QueueSessionResult,
): AgentSessionDetail | Response {
  return result.status === "queued"
    ? result.detail
    : queueFailureResponse(result);
}

export async function queueSessionForUser(
  dependencies: SessionQueueDependencies,
  userId: string,
  sessionId: string,
  prompt?: PromptInput,
): Promise<Response> {
  const existing = dependencies.store.get(
    userId,
    sessionId,
    dependencies.workspaceId,
  );
  const draining =
    existing !== undefined && !dependencies.runtimes.accepts(existing.runnerId);
  const unavailable = unavailableSessionResponse(existing);
  if (unavailable !== undefined || existing === undefined) {
    return unavailable ?? createApiError("not_found", 404);
  }
  if (
    !draining &&
    !dependencies.runnerIsAvailable(
      userId,
      existing.runnerId,
      existing.workspaceId,
    )
  ) {
    return createApiError("runner_unavailable", 409);
  }
  return dependencies.credential(userId, existing, (credential) => {
    const queued = queuedSessionDetail(
      queueSession(
        dependencies,
        userId,
        existing.id,
        prompt,
        dependencies.workspaceId,
      ),
    );

    if (queued instanceof Response) {
      return queued;
    }
    const detail = queued;
    if (draining) {
      dependencies.notify(userId, sessionId);
      return createJsonResponse(detail, 202);
    }
    if (!dependencies.launch(detail, credential, userId)) {
      const response = failedSessionLaunchResponse(
        dependencies,
        detail,
        userId,
        "agent",
      );
      dependencies.notify(userId, sessionId);
      return response;
    }
    dependencies.notify(userId, sessionId);
    return createJsonResponse(detail, 202);
  });
}
