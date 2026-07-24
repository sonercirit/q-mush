import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
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
) => Promise<string> | string;

export interface SessionAgentActionDependencies {
  readonly discoverSessionMetadata: (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ) => Promise<{
    readonly maxContextTokens: number | null;
    readonly providerPricing: AgentSessionDetail["providerPricing"];
  }>;
  readonly draining: () => boolean;
  readonly launchSession: (
    credential: ProviderCredentialAccess,
    session: AgentSessionDetail,
    ownerId: string,
  ) => boolean;
  readonly now: () => number;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runnerIsAvailable: (userId: string, runnerId: string) => boolean;
  readonly store: SessionStore;
  readonly withCredential: (
    userId: string,
    selection: SessionAgentCredentialSelection,
    action: SessionAgentCredentialAction,
  ) => Promise<string>;
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
  const enqueue = async (
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
  ): Promise<string> => {
    const metadata = await options.dependencies.discoverSessionMetadata(
      input,
      credential,
    );
    if (options.dependencies.draining()) {
      return sessionToolOutput({ error: "server_restarting" });
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
      options.dependencies.store.appendErrorMessage(
        child.id,
        "Session failed: the child session could not be launched",
        options.dependencies.now(),
      );
      options.dependencies.store.mark(
        child.id,
        "failed",
        options.dependencies.now(),
      );
      throw new Error("The child session could not be launched");
    }
    options.dependencies.notify(options.userId, child.id);
    return sessionToolOutput({ sessionId: child.id, status: "spawned" });
  };
  return options.dependencies.withCredential(
    options.userId,
    options.input,
    (credential) => enqueue(options.input, credential),
  );
}
