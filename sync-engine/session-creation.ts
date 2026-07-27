import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError } from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import { persistQueuedRestartHandoff } from "./session-agent-action-helpers.ts";
import {
  selectedSessionModel,
  type CreateSessionInput,
} from "./session-input.ts";
import { sessionMetadata } from "./session-provider-selection.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { CreateAgentSession } from "./session-store-create.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionLaunchBoundary {
  readonly launch: SessionLaunch;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}

type SessionLaunch = (
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  userId: string,
  operation?: RestartHandoffOperation,
) => boolean;

export type RestartSessionLaunch = (
  ...arguments_: [
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    operation: RestartHandoffOperation,
  ]
) => boolean;

export type SessionNotification = (userId: string, sessionId: string) => void;

interface SessionRestartPauseDependencies {
  readonly now: typeof Date.now;
  readonly runtimes: Pick<SessionRuntimes, "pendingRestart">;
  readonly store: Pick<SessionStore, "pauseQueuedForRestart">;
}

export function pauseSessionForRestart(
  dependencies: SessionRestartPauseDependencies,
  detail: AgentSessionDetail,
  operation: RestartHandoffOperation,
): boolean {
  const restart = dependencies.runtimes.pendingRestart(detail.runnerId);
  return (
    restart !== undefined &&
    persistQueuedRestartHandoff(
      dependencies.store,
      detail,
      restart,
      operation,
      dependencies.now(),
    )
  );
}

export function failedSessionLaunchResponse(
  dependencies: SessionRestartPauseDependencies & {
    readonly store: Pick<
      SessionStore,
      "get" | "pauseQueuedForRestart" | "transitionRuntime"
    >;
  },
  detail: AgentSessionDetail,
  userId: string,
  operation: RestartHandoffOperation,
): Response {
  if (pauseSessionForRestart(dependencies, detail, operation)) {
    return createApiError("server_restarting", 503);
  }
  dependencies.store.transitionRuntime(
    detail.id,
    "failed",
    dependencies.now(),
    detail.generation,
  );
  return dependencies.store.get(userId, detail.id)?.status === "paused"
    ? createApiError("server_restarting", 503)
    : createApiError("session_launch_failed", 500);
}

export type SessionCreationDependencies = Omit<
  SessionLaunchBoundary,
  "runtimes" | "store"
> & {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly onCreated?: (detail: AgentSessionDetail) => void;
  readonly runtimes: Pick<SessionRuntimes, "accepts" | "pendingRestart">;
  readonly serializeCreatedDetail?: CreatedSessionSerializer;
  readonly store: Pick<
    SessionStore,
    "create" | "get" | "pauseQueuedForRestart" | "transitionRuntime"
  >;
};

interface PreparedSessionResponse {
  readonly response: Response;
}

type CreatedSessionSerializer = (detail: AgentSessionDetail) => string;

function preparedSessionResponse(
  detail: AgentSessionDetail,
  status: number,
  serialize: CreatedSessionSerializer = JSON.stringify,
): PreparedSessionResponse | undefined {
  try {
    const serialized = serialize(detail);
    return {
      response: new Response(serialized, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
        status,
      }),
    };
  } catch {
    return undefined;
  }
}

function authoritativeCreatedDetail(
  dependencies: SessionCreationDependencies,
  userId: string,
  sessionId: string,
): AgentSessionDetail | undefined {
  try {
    return dependencies.store.get(userId, sessionId);
  } catch {
    return undefined;
  }
}

function notifyCreated(
  dependencies: SessionCreationDependencies,
  userId: string,
  detail: AgentSessionDetail,
): void {
  try {
    dependencies.notify(userId, detail.id);
  } catch {
    // The committed state remains authoritative when notification fails.
  }
}

function reportCreated(
  dependencies: SessionCreationDependencies,
  detail: AgentSessionDetail,
): void {
  try {
    dependencies.onCreated?.(detail);
  } catch {
    // Observers cannot change the already committed creation outcome.
  }
}

function committedSessionResponse(
  dependencies: SessionCreationDependencies,
  userId: string,
  sessionId: string,
): Response | undefined {
  const authoritative = authoritativeCreatedDetail(
    dependencies,
    userId,
    sessionId,
  );
  if (authoritative === undefined) {
    return undefined;
  }
  const response = preparedSessionResponse(
    authoritative,
    201,
    dependencies.serializeCreatedDetail,
  )?.response;
  if (response !== undefined) {
    reportCreated(dependencies, authoritative);
  }
  return response;
}

export async function createValidatedSession(
  dependencies: SessionCreationDependencies,
  user: AuthenticatedUser,
  input: CreateSessionInput & Pick<CreateAgentSession, "workspaceId">,
  credential: ProviderCredentialAccess,
): Promise<Response> {
  const selectedModel = selectedSessionModel(input, credential.source);
  const metadata = await sessionMetadata({
    credential,
    discoverModels: dependencies.discoverModels,
    discoverProviders: dependencies.discoverOpenRouterProviders,
    input: { ...input, model: selectedModel },
    ownerId: user.id,
  });
  if ("error" in metadata) {
    return createApiError(
      metadata.error === "provider_unavailable"
        ? "openrouter_provider_unavailable"
        : "openrouter_provider_validation_failed",
      metadata.error === "provider_unavailable" ? 409 : 502,
    );
  }
  if (!dependencies.runtimes.accepts(input.runnerId)) {
    return createApiError("server_restarting", 503);
  }
  let created: ReturnType<SessionStore["create"]>;
  try {
    created = dependencies.store.create(
      {
        ...input,
        ...metadata,
        model: selectedModel,
        userId: user.id,
        workspaceId: input.workspaceId,
      },
      dependencies.now(),
    );
  } catch {
    return createApiError("outcome_unknown", 503);
  }
  if (created.status !== "created") {
    return createApiError(created.status, 409);
  }
  const initialResponse = preparedSessionResponse(
    created.detail,
    201,
    dependencies.serializeCreatedDetail,
  );
  if (initialResponse === undefined) {
    notifyCreated(dependencies, user.id, created.detail);
    return createApiError("outcome_unknown", 503);
  }
  let launchOutcome: "launched" | "not_launched" | "uncertain";
  try {
    launchOutcome = dependencies.launch(created.detail, credential, user.id)
      ? "launched"
      : "not_launched";
  } catch {
    launchOutcome = "uncertain";
  }
  if (launchOutcome === "not_launched") {
    try {
      failedSessionLaunchResponse(
        dependencies,
        created.detail,
        user.id,
        "agent",
      );
    } catch {
      launchOutcome = "uncertain";
    }
  }
  notifyCreated(dependencies, user.id, created.detail);
  const response = committedSessionResponse(
    dependencies,
    user.id,
    created.detail.id,
  );
  return (
    response ??
    createApiError(
      "outcome_unknown",
      launchOutcome === "not_launched" ? 500 : 503,
    )
  );
}
