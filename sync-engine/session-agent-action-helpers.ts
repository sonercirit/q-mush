import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AppDatabase } from "../shared/database.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createJsonResponse } from "./http.ts";
import {
  lastSessionMessage,
  sessionToolOutput,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
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
  readonly database: AppDatabase;
  readonly discoverModels: (
    provider: "openai" | "openrouter",
    credential: ProviderCredentialAccess,
  ) => Promise<AgentModelCatalog>;
  readonly store: SessionStore;
  readonly now: () => number;
  readonly draining: () => boolean;
  readonly launchSession: (
    credential: ProviderCredentialAccess,
    session: AgentSessionDetail,
    ownerId: string,
  ) => boolean;
  readonly discoverSessionMetadata: (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ) => Promise<{
    readonly maxContextTokens: number | null;
    readonly providerPricing: AgentSessionDetail["providerPricing"];
  }>;
  readonly readCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly withCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
    action: SessionAgentCredentialAction,
  ) => Promise<Response>;
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
  const status = completed.status === "idle" ? "completed" : completed.status;
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
  async function enqueue(
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ): Promise<Response> {
    const metadata = await options.dependencies.discoverSessionMetadata(
      input,
      credential,
    );
    if (options.dependencies.draining()) {
      return createJsonResponse({ error: "server_restarting" }, 503);
    }
    const created = options.dependencies.store.create(
      {
        ...input,
        ...metadata,
        autoCompact: true,
        parentSessionId: options.parentSessionId,
        userId: options.userId,
      },
      options.dependencies.now(),
    );
    if (created.status === "runner_unavailable") {
      return createJsonResponse({ error: "runner_unavailable" }, 409);
    }
    const { detail: child } = created;
    if (
      !options.dependencies.launchSession(credential, child, options.userId)
    ) {
      options.dependencies.store.appendErrorMessage(
        child.id,
        "Session failed: the child session could not be launched",
        options.dependencies.now(),
        child.generation,
      );
      options.dependencies.store.mark(
        child.id,
        "failed",
        options.dependencies.now(),
        child.generation,
      );
      throw new Error("The child session could not be launched");
    }
    options.dependencies.notify(options.userId, child.id);
    return createJsonResponse({ sessionId: child.id, status: "spawned" });
  }
  const response = await options.dependencies.withCredential(
    options.userId,
    options.input,
    (credential) => enqueue(options.input, credential),
  );
  return responseToolOutput(response);
}
