import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError, parseJsonRequest } from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import {
  startManualSessionCompaction,
  type ManualCompactionDependencies,
} from "./session-compaction-actions.ts";
import {
  createValidatedSession,
  type SessionLaunchBoundary,
} from "./session-creation.ts";
import type {
  SessionCredentialAction,
  SessionCredentialSelection,
} from "./session-credential-access.ts";
import {
  readCreateSession,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import { queueSessionForUser } from "./session-queue.ts";
import { serverRestartingResponse } from "./session-restart-gate.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";

export interface SessionUserActionDependencies {
  readonly compactionBoundary: (
    operation: "compact",
  ) => Omit<ManualCompactionDependencies, "workspaceId">;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly launchBoundary: () => SessionLaunchBoundary;
  readonly restartSignal: () => AbortSignal;
  readonly runnerIsAvailable: SessionRunnerAvailability;
  readonly withCredential: (
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ) => Promise<Response>;
}

export async function createSessionForUser(
  dependencies: SessionUserActionDependencies,
  request: Request,
  user: AuthenticatedUser,
  workspaceId: string,
): Promise<Response> {
  const restartSignal = dependencies.restartSignal();
  const input = await parseJsonRequest(request, readCreateSession);
  return input === undefined
    ? createApiError("invalid_request", 400)
    : createValidatedSessionForUser(
        dependencies,
        user,
        input,
        workspaceId,
        restartSignal,
      );
}

function createValidatedSessionForUser(
  dependencies: SessionUserActionDependencies,
  user: AuthenticatedUser,
  input: CreateSessionInput,
  workspaceId: string,
  restartSignal: AbortSignal,
): Promise<Response> {
  if (restartSignal.aborted) {
    return Promise.resolve(serverRestartingResponse());
  }
  const scopedInput = { ...input, workspaceId };
  const available = dependencies.runnerIsAvailable(
    user.id,
    scopedInput.runnerId,
    workspaceId,
  );
  if (!available) {
    return Promise.resolve(createApiError("runner_unavailable", 409));
  }
  return dependencies.withCredential(user.id, scopedInput, (credential) =>
    createValidatedSession(
      {
        discoverModels: dependencies.discoverModels,
        discoverOpenRouterProviders: dependencies.discoverOpenRouterProviders,
        restartSignal: dependencies.restartSignal,
        ...dependencies.launchBoundary(),
      },
      user,
      scopedInput,
      credential,
      restartSignal,
    ),
  );
}

export function compactSessionForUser(
  dependencies: SessionUserActionDependencies,
  user: AuthenticatedUser,
  sessionId: string,
  workspaceId: string,
): Promise<Response> {
  return startManualSessionCompaction(
    { ...dependencies.compactionBoundary("compact"), workspaceId },
    user,
    sessionId,
  );
}

export function queueSessionPromptForUser(
  dependencies: SessionUserActionDependencies,
  user: AuthenticatedUser,
  sessionId: string,
  workspaceId: string,
  prompt?: PromptInput,
): Promise<Response> {
  return queueSessionForUser(
    {
      ...dependencies.launchBoundary(),
      credential: dependencies.withCredential,
      runnerIsAvailable: dependencies.runnerIsAvailable,
      workspaceId,
    },
    user.id,
    sessionId,
    prompt,
  );
}
