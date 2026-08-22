import type { AppDatabase } from "../shared/database.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
} from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import {
  sessionToolOutput,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type { SessionRequestModelMetadata } from "./session-provider-selection.ts";
import { restartSignalIsAborted } from "./session-restart-gate.ts";
import type { RestartRequest } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

type SessionAgentCredentialSelection = Pick<
  AgentSessionDetail,
  "credentialId" | "provider" | "workspaceId"
>;

export interface SessionAgentActionDependencies {
  readonly settled?: (sessionId: string) => Promise<void>;
  readonly database: AppDatabase;
  readonly discoverModels: AgentModelDiscoverer;
  readonly draining?: () => boolean;
  readonly store: SessionStore;
  readonly now: () => number;
  readonly restartSignal: () => AbortSignal;
  readonly pendingRestart: (runnerId: string) => RestartRequest | undefined;
  readonly launchSession: (
    credential: ProviderCredentialAccess,
    session: AgentSessionDetail,
    ownerId: string,
    operation?: RestartHandoffOperation,
  ) => boolean;
  readonly discoverSessionMetadata: (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
    userId: string,
    rejectCredentialErrors: boolean,
    signal?: AbortSignal,
  ) => Promise<SessionRequestModelMetadata>;
  readonly readCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly modelCredentialPool?: ModelCredentialPool;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runnerIsAvailable: (
    userId: string,
    runnerId: string,
    workspaceId: string,
  ) => boolean;
  withCredential(
    userId: string,
    selection: SessionAgentCredentialSelection,
    action: SessionCredentialAction,
  ): Promise<Response>;
}

export interface QueuedRestartHandoffStore {
  pauseQueuedForRestart(
    identity: { readonly generation: number; readonly sessionId: string },
    requestedBy: "runner" | "server",
    restartId: string,
    operation: RestartHandoffOperation,
    now: number,
  ): boolean;
}

export function persistQueuedRestartHandoff(
  store: QueuedRestartHandoffStore,
  detail: AgentSessionDetail,
  restart: RestartRequest,
  operation: RestartHandoffOperation,
  now: number,
): boolean {
  return store.pauseQueuedForRestart(
    { generation: detail.generation, sessionId: detail.id },
    restart.requestedBy,
    restart.restartId,
    operation,
    now,
  );
}

export function pauseQueuedSessionForRestart(
  dependencies: Pick<
    SessionAgentActionDependencies,
    "now" | "notify" | "pendingRestart" | "store"
  >,
  detail: AgentSessionDetail,
  userId: string,
): boolean {
  const restart = dependencies.pendingRestart(detail.runnerId);
  if (restart === undefined) {
    return false;
  }
  const paused = persistQueuedRestartHandoff(
    dependencies.store,
    detail,
    restart,
    "agent",
    dependencies.now(),
  );
  if (paused) {
    dependencies.notify(userId, detail.id);
  }
  return paused;
}

export async function responseToolOutput(response: Response): Promise<string> {
  const value: unknown = await response.json();
  return sessionToolOutput(value);
}

export function sessionCanResume(
  session: Pick<AgentSessionDetail, "runnerRequired" | "status">,
): boolean {
  return (
    !session.runnerRequired &&
    session.status !== "paused" &&
    session.status !== "queued" &&
    session.status !== "running"
  );
}

export async function spawnAgentSession(options: {
  readonly authority: SessionExecutionAuthority;
  readonly dependencies: SessionAgentActionDependencies;
  readonly input: SpawnSessionToolInput;
  readonly signal?: AbortSignal;
  readonly terminal: (detail: AgentSessionDetail) => void;
  readonly userId: string;
}): Promise<string> {
  const { authority, dependencies, input, userId } = options;
  const parent = dependencies.store.get(userId, authority.sessionId);
  if (parent === undefined) {
    return sessionToolOutput({ error: "parent_session_unavailable" });
  }

  const selection = { ...input, workspaceId: parent.workspaceId };
  const balanced = isBalancedCredentialId(
    selection.provider,
    selection.credentialId,
  );
  const summaries = ProviderCredentialStore.listActiveModelCredentials(
    dependencies.database,
    userId,
    selection.provider,
    parent.workspaceId,
  );
  const reservedCredential = balanced
    ? summaries[0]
    : summaries.find(({ id }) => id === selection.credentialId);
  if (reservedCredential === undefined) {
    return sessionToolOutput({ error: "credential_unavailable" });
  }

  const created = dependencies.store.create(
    {
      ...input,
      adaptiveThinking: null,
      credentialId: reservedCredential.id,
      maxContextTokens: null,
      maxOutputTokens: null,
      parentGeneration: authority.generation,
      parentSessionId: authority.sessionId,
      providerPricing: null,
      userId,
      workspaceId: parent.workspaceId,
    },
    dependencies.now(),
  );
  if (created.status !== "created") {
    return sessionToolOutput({ error: created.status });
  }
  const child = created.detail;
  const childIdentity = { generation: child.generation, sessionId: child.id };
  dependencies.notify(userId, child.id);

  const fail = (
    error: string,
    content = "Session failed: the child session could not be prepared",
  ): string => {
    const failed = dependencies.store.failSpawnedSessionPreparation(
      userId,
      child.id,
      child.generation,
      content,
      dependencies.now(),
    );
    dependencies.notify(userId, child.id);
    const status = failed
      ? "failed"
      : (dependencies.store.get(userId, child.id)?.status ?? "unavailable");
    return sessionToolOutput({ error, sessionId: child.id, status });
  };
  const claim = (): boolean =>
    dependencies.store.claimSpawnedSession(userId, childIdentity, authority);
  const prepareAndLaunch = async (
    credential: ProviderCredentialAccess,
  ): Promise<string | undefined> => {
    let metadata: SessionRequestModelMetadata;
    try {
      metadata = await dependencies.discoverSessionMetadata(
        { ...input, credentialId: credential.id },
        credential,
        userId,
        balanced,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "SessionLaunchError") {
        throw error;
      }
      if (balanced && dependencies.modelCredentialPool !== undefined) {
        if (
          dependencies.modelCredentialPool.reject(
            userId,
            selection,
            credential.id,
            error,
          )
        ) {
          return undefined;
        }
        throw error;
      }
      return fail("provider_unavailable");
    }
    const prepared = dependencies.store.prepareSpawnedSession(
      childIdentity,
      userId,
      authority,
      { ...metadata, credentialId: credential.id },
      dependencies.now(),
    );
    if (prepared !== "prepared") {
      return fail("parent_stale");
    }
    const preparedChild = dependencies.store.get(userId, child.id);
    if (preparedChild === undefined) {
      return fail("parent_stale");
    }
    dependencies.notify(userId, child.id);
    if (
      restartSignalIsAborted(dependencies.restartSignal) ||
      dependencies.draining?.() === true
    ) {
      if (!claim()) return fail("parent_stale");
      return sessionToolOutput({ sessionId: child.id, status: "queued" });
    }
    if (!claim()) return fail("parent_stale");
    if (!dependencies.launchSession(credential, preparedChild, userId)) {
      if (pauseQueuedSessionForRestart(dependencies, preparedChild, userId)) {
        return sessionToolOutput({ error: "server_restarting" });
      }
      fail(
        "session_launch_failed",
        "Session failed: the child session could not be launched",
      );
      const failedChild = dependencies.store.get(userId, child.id);
      if (failedChild !== undefined) options.terminal(failedChild);
      const launchError = new Error("The child session could not be launched");
      launchError.name = "SessionLaunchError";
      throw launchError;
    }
    return sessionToolOutput({ sessionId: child.id, status: "spawned" });
  };

  if (balanced && dependencies.modelCredentialPool !== undefined) {
    let credentials: readonly ProviderCredentialAccess[];
    try {
      credentials = await dependencies.modelCredentialPool.candidates(
        userId,
        selection,
      );
    } catch {
      return fail("credential_unavailable");
    }
    if (credentials.length > 0) {
      for (const credential of credentials) {
        const output = await prepareAndLaunch(credential);
        if (output !== undefined) return output;
      }
      return fail("credential_unavailable");
    }
  }

  try {
    const response = await dependencies.withCredential(
      userId,
      { ...selection, credentialId: reservedCredential.id },
      async (value) =>
        new Response(await prepareAndLaunch(value), {
          headers: { "content-type": "application/json" },
        }),
    );
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "SessionLaunchError") {
      throw error;
    }
    return fail("credential_unavailable");
  }
}
