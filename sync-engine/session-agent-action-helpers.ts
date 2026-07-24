import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createJsonResponse } from "./http.ts";
import {
  lastSessionMessage,
  sessionToolOutput,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
import type { RestartRequest } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface SessionAgentCredentialSelection {
  readonly credentialId: string;
  readonly provider: "openai" | "openrouter";
}

interface ParentSessionReport {
  readonly content: string;
  readonly parentId: string;
}

type SessionAgentCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export interface SessionAgentActionDependencies {
  // cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
  readonly store: SessionStore;
  readonly acceptsRunner: (runnerId: string) => boolean;
  readonly pendingRestart: (runnerId: string) => RestartRequest | undefined;
  readonly now: () => number;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly launchSession: (
    credential: ProviderCredentialAccess,
    session: AgentSessionDetail,
    ownerId: string,
  ) => boolean;
  // cpd-ignore-end
  readonly discoverSessionMetadata: (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ) => Promise<{
    readonly maxContextTokens: number | null;
    readonly providerPricing: AgentSessionDetail["providerPricing"];
  }>;
  readonly withCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
    action: SessionAgentCredentialAction,
  ) => Promise<Response>;
}

export function pauseQueuedSessionForRestart(
  dependencies: SessionAgentActionDependencies,
  detail: AgentSessionDetail,
  userId: string,
): boolean {
  const restart = dependencies.pendingRestart(detail.runnerId);
  if (restart === undefined) {
    return false;
  }
  const paused = dependencies.store.pauseQueuedForRestart(
    detail.id,
    restart.requestedBy,
    restart.restartId,
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
  const lastMessage = lastSessionMessage(completed);
  const status =
    completed.status === "idle"
      ? "completed"
      : completed.status === "paused"
        ? "running"
        : completed.status;
  const summary = sessionToolOutput({
    lastMessage:
      lastMessage === undefined
        ? null
        : { content: lastMessage.content, role: lastMessage.role },
    sessionId: completed.id,
    status,
  });
  return {
    content: `Spawned session completed:\n${summary}`,
    parentId: options.parentId,
  };
}

export async function spawnAgentSession(options: {
  readonly dependencies: SessionAgentActionDependencies;
  readonly input: SpawnSessionToolInput;
  readonly parentSessionId: string;
  readonly userId: string;
}): Promise<string> {
  const notifyChild = (childId: string): void => {
    options.dependencies.notify(options.userId, childId);
  };
  async function enqueue(
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ): Promise<Response> {
    const metadata = await options.dependencies.discoverSessionMetadata(
      input,
      credential,
    );
    if (!options.dependencies.acceptsRunner(input.runnerId)) {
      return createJsonResponse({ error: "server_restarting" }, 503);
    }
    const child = options.dependencies.store.create(
      {
        ...input,
        ...metadata,
        autoCompact: true,
        parentSessionId: options.parentSessionId,
        userId: options.userId,
      },
      options.dependencies.now(),
    );
    if (
      !options.dependencies.launchSession(credential, child, options.userId)
    ) {
      const restart = options.dependencies.pendingRestart(child.runnerId);
      if (restart !== undefined) {
        const paused = options.dependencies.store.pauseQueuedForRestart(
          child.id,
          restart.requestedBy,
          restart.restartId,
          options.dependencies.now(),
        );
        if (!paused) {
          throw new Error("The child restart handoff could not be persisted");
        }
        notifyChild(child.id);
        return createJsonResponse({ error: "server_restarting" }, 503);
      }
      const failedAt = options.dependencies.now();
      options.dependencies.store.appendErrorMessage(
        child.id,
        "Session failed: the child session could not be launched",
        failedAt,
      );
      options.dependencies.store.mark(child.id, "failed", failedAt);
      throw new Error("The child session could not be launched");
    }
    notifyChild(child.id);
    return createJsonResponse({ sessionId: child.id, status: "spawned" });
  }
  const response = await options.dependencies.withCredential(
    options.userId,
    options.input,
    (credential) => enqueue(options.input, credential),
  );
  return responseToolOutput(response);
}
