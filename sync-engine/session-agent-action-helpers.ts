import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AppDatabase } from "../shared/database.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import { createJsonResponse } from "./http.ts";
import {
  sessionToolOutput,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type { RestartRequest } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

type SessionAgentCredentialSelection = Pick<
  AgentSessionDetail,
  "credentialId" | "provider" | "workspaceId"
>;

interface ParentSessionReport {
  readonly content: string;
  readonly parentId: string;
}

interface SessionAgentMetadata {
  readonly maxContextTokens: number | null;
  readonly providerPricing: AgentSessionDetail["providerPricing"];
}

export interface SessionAgentActionDependencies {
  readonly settled?: (sessionId: string) => Promise<void>;
  readonly database: AppDatabase;
  readonly discoverModels: (
    provider: ProviderId,
    credential: ProviderCredentialAccess,
  ) => Promise<AgentModelCatalog>;
  readonly store: SessionStore;
  readonly now: () => number;
  readonly draining: () => boolean;
  readonly pendingRestart: (runnerId: string) => RestartRequest | undefined;
  readonly launchSession: (
    credential: ProviderCredentialAccess,
    session: AgentSessionDetail,
    ownerId: string,
  ) => boolean;
  readonly discoverSessionMetadata: (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => Promise<SessionAgentMetadata>;
  readonly readCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
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

export function spawnedSessionReport(options: {
  readonly childId: string;
  readonly dependencies: SessionAgentActionDependencies;
  readonly parentId: string;
  readonly userId: string;
}): ParentSessionReport | undefined {
  const completed = options.dependencies.store.get(
    options.userId,
    options.childId,
  );
  if (completed === undefined) {
    return undefined;
  }
  if (
    completed.status !== "completed" &&
    completed.status !== "failed" &&
    completed.status !== "stopped"
  ) {
    return undefined;
  }
  const failed = completed.status === "failed";
  const terminalAssistant = completed.messages.findLast(
    ({ role, toolCalls }) => role === "assistant" && toolCalls.length === 0,
  );
  const assistant = completed.messages.findLast(
    ({ role }) => role === "assistant",
  );
  const failure = failed
    ? completed.messages.findLast(({ role }) => role === "error")
    : undefined;
  const lastMessage = failed
    ? (assistant?.content.trim().length ?? 0) > 0
      ? assistant
      : {
          content:
            failure?.content ??
            "Session failed without a recorded failure reason",
          role: "error" as const,
        }
    : completed.status === "stopped"
      ? completed.messages.findLast(({ role }) => role !== "thinking")
      : terminalAssistant;
  const status = completed.status;
  const summary = sessionToolOutput({
    lastMessage:
      lastMessage === undefined
        ? null
        : { content: lastMessage.content, role: lastMessage.role },
    sessionId: completed.id,
    status,
  });
  return {
    content: `Spawned session ${failed ? "failed" : "completed"}:\n${summary}`,
    parentId: options.parentId,
  };
}

function sessionLaunchResponse(
  sessionId: string,
  status: "queued" | "spawned",
): Response {
  return createJsonResponse({ sessionId, status });
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
  readonly userId: string;
}): Promise<string> {
  const parent = options.dependencies.store.get(
    options.userId,
    options.authority.sessionId,
  );
  if (parent === undefined) {
    return sessionToolOutput({ error: "parent_session_unavailable" });
  }

  async function enqueue(
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
    workspaceId: string,
  ): Promise<Response> {
    const metadata = await options.dependencies.discoverSessionMetadata(
      input,
      credential,
      options.userId,
    );
    const created = options.dependencies.store.create(
      {
        ...input,
        ...metadata,
        parentGeneration: options.authority.generation,
        parentSessionId: options.authority.sessionId,
        userId: options.userId,
        workspaceId,
      },
      options.dependencies.now(),
    );
    if (created.status !== "created") {
      return createJsonResponse({ error: created.status }, 409);
    }
    const { detail: child } = created;
    const notifiedResponse = (status: "queued" | "spawned"): Response => {
      options.dependencies.notify(options.userId, child.id);
      return sessionLaunchResponse(child.id, status);
    };
    if (options.dependencies.draining()) {
      return notifiedResponse("queued");
    }
    const launch = options.dependencies.launchSession(
      credential,
      child,
      options.userId,
    );
    if (!launch) {
      if (
        pauseQueuedSessionForRestart(
          options.dependencies,
          child,
          options.userId,
        )
      ) {
        return createJsonResponse({ error: "server_restarting" }, 503);
      }
      options.dependencies.store.appendRuntimeErrorMessage(
        child.id,
        "Session failed: the child session could not be launched",
        options.dependencies.now(),
        child.generation,
      );
      options.dependencies.store.transitionRuntime(
        child.id,
        "failed",
        options.dependencies.now(),
        child.generation,
      );
      throw new Error("The child session could not be launched");
    }
    return notifiedResponse("spawned");
  }
  const selection = { ...options.input, workspaceId: parent.workspaceId };
  const response = await options.dependencies.withCredential(
    options.userId,
    selection,
    (credential) => enqueue(options.input, credential, parent.workspaceId),
  );
  return responseToolOutput(response);
}
