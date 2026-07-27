import type { AgentImage } from "../shared/agent-images.ts";
import { createdAuditFields } from "../shared/audit.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { runnerIsAvailable } from "./runner-availability-store.ts";
import { sessionExecutionIsCurrent } from "./session-execution-authority.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { readStoredSessionResult } from "./session-store-result.ts";
import { userMessageValues } from "./session-store-values.ts";

export interface CreateAgentSession extends Pick<
  AgentSessionSummary,
  | "autoCompact"
  | "executionEnvironment"
  | "maxContextTokens"
  | "model"
  | "openRouterProviderTag"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "runnerId"
  | "tools"
  | "workingDirectory"
  | "workspaceId"
> {
  readonly credentialId: string;
  readonly images: readonly AgentImage[];
  readonly parentGeneration?: number;
  readonly parentSessionId?: string;
  readonly prompt: string;
  readonly userId: string;
}

export type CreateSessionResult =
  | { readonly detail: AgentSessionDetail; readonly status: "created" }
  | { readonly status: "parent_stale" | "runner_unavailable" };

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "Image task").slice(0, 80);
}

export function createStoredSession(
  resources: SessionStoreWriteResources,
  input: CreateAgentSession,
  now: number,
): CreateSessionResult {
  if (
    input.maxContextTokens !== null &&
    (!Number.isSafeInteger(input.maxContextTokens) ||
      input.maxContextTokens <= 0)
  ) {
    throw new Error("The agent session context limit is invalid");
  }

  if (input.openRouterProviderTag !== null && input.provider !== "openrouter") {
    throw new Error("The agent session serving provider is invalid");
  }

  const sessionId = resources.generateId(now);
  const generatedIds = [sessionId, resources.generateId(now)] as const;
  const messageId = generatedIds[1];
  const status = resources.database.transaction((transaction) => {
    const parentSessionId = input.parentSessionId;
    const parentGeneration = input.parentGeneration;
    if ((parentSessionId === undefined) !== (parentGeneration === undefined)) {
      return "parent_stale" as const;
    }
    if (
      parentSessionId !== undefined &&
      parentGeneration !== undefined &&
      !sessionExecutionIsCurrent(
        transaction,
        { generation: parentGeneration, sessionId: parentSessionId },
        input.userId,
      )
    ) {
      return "parent_stale" as const;
    }
    if (!runnerIsAvailable(transaction, input.userId, input.runnerId, now)) {
      return "runner_unavailable" as const;
    }
    transaction
      .insert(agentSessions)
      .values({
        ...createdAuditFields(input.userId, now),
        autoCompact: input.autoCompact,
        executionEnvironment: input.executionEnvironment,
        id: sessionId,
        maxContextTokens: input.maxContextTokens,
        model: input.model,
        openRouterProviderTag: input.openRouterProviderTag,
        parentExecutionGeneration: input.parentGeneration ?? null,
        parentSessionId: input.parentSessionId ?? null,
        provider: input.provider,
        providerCredentialId: input.credentialId,
        providerPricing: serializeProviderPricing(input.providerPricing),
        reasoningEffort: input.reasoningEffort,
        runnerId: input.runnerId,
        status: "queued",
        title: titleFromPrompt(input.prompt),
        tools: JSON.stringify(input.tools),
        userId: input.userId,
        workingDirectory: input.workingDirectory,
        workspaceId: input.workspaceId,
      })
      .run();
    transaction
      .insert(agentMessages)
      .values(
        userMessageValues({
          content: input.prompt,
          id: messageId,
          images: input.images,
          now,
          segment: 0,
          sessionId,
          userId: input.userId,
        }),
      )
      .run();
    return "created" as const;
  });

  if (status !== "created") {
    return { status };
  }
  return readStoredSessionResult(
    resources,
    input.userId,
    sessionId,
    status,
    "The agent session could not be read after creation",
  );
}
