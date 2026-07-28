import type { AgentImage } from "../shared/agent-images.ts";
import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { runnerIsAvailable } from "./runner-availability-store.ts";
import { sessionExecutionIsCurrent } from "./session-execution-authority.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { readStoredSessionResult } from "./session-store-result.ts";
import {
  insertStoredMessage,
  recordedMessageValues,
  storedUserMessageValues,
  userMessageValues,
} from "./session-store-values.ts";

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

export interface ForkAgentSession extends Pick<
  CreateAgentSession,
  "autoCompact" | "userId" | "workspaceId"
> {
  readonly messages: readonly AgentSessionMessage[];
  readonly source: AgentSessionSummary;
}

export type ForkSessionResult = Readonly<{
  detail: AgentSessionDetail;
  status: "forked";
}>;

function validateSessionConfiguration(
  input: Pick<
    CreateAgentSession,
    "maxContextTokens" | "openRouterProviderTag" | "provider"
  >,
): void {
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
}

function storedSessionValues(
  input: Pick<
    CreateAgentSession,
    | "autoCompact"
    | "credentialId"
    | "executionEnvironment"
    | "maxContextTokens"
    | "model"
    | "openRouterProviderTag"
    | "provider"
    | "providerPricing"
    | "reasoningEffort"
    | "runnerId"
    | "tools"
    | "userId"
    | "workingDirectory"
    | "workspaceId"
  > &
    Pick<AgentSessionSummary, "runnerRequired">,
  id: string,
  now: number,
  options: Readonly<{
    parentExecutionGeneration: number | null;
    parentSessionId: string | null;
    status: "idle" | "queued";
    title: string;
  }>,
) {
  return {
    ...createdAuditFields(input.userId, now),
    autoCompact: input.autoCompact,
    executionEnvironment: input.executionEnvironment,
    id,
    maxContextTokens: input.maxContextTokens,
    model: input.model,
    openRouterProviderTag: input.openRouterProviderTag,
    parentExecutionGeneration: options.parentExecutionGeneration,
    parentSessionId: options.parentSessionId,
    provider: input.provider,
    providerCredentialId: input.credentialId,
    providerPricing: serializeProviderPricing(input.providerPricing),
    reasoningEffort: input.reasoningEffort,
    runnerId: input.runnerId,
    runnerRequired: input.runnerRequired,
    status: options.status,
    title: options.title,
    tools: JSON.stringify(input.tools),
    userId: input.userId,
    workingDirectory: input.workingDirectory,
    workspaceId: input.workspaceId,
  };
}

function insertSession(
  database: Pick<AppDatabase, "insert">,
  values: typeof agentSessions.$inferInsert,
): void {
  database.insert(agentSessions).values(values).run();
}

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
  validateSessionConfiguration(input);

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
    insertSession(
      transaction,
      storedSessionValues({ ...input, runnerRequired: false }, sessionId, now, {
        parentExecutionGeneration: input.parentGeneration ?? null,
        parentSessionId: input.parentSessionId ?? null,
        status: "queued",
        title: titleFromPrompt(input.prompt),
      }),
    );
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

function forkMessageValues(message: AgentSessionMessage) {
  const { content, toolCallId, toolCalls, toolName } = message;
  switch (message.role) {
    case "assistant":
      return recordedMessageValues({
        content,
        role: "assistant",
        toolCalls,
      });
    case "tool":
      if (toolCallId === null || toolName === null) {
        throw new Error("A stored tool result has no tool identity");
      }
      return recordedMessageValues({
        content,
        role: "tool",
        toolCallId,
        toolName,
      });
    case "user":
      return storedUserMessageValues(content, message.images);
    case "error":
    case "system":
    case "thinking":
      throw new Error("A non-conversation message cannot be copied");
  }
}

export function forkStoredSession(
  resources: SessionStoreWriteResources,
  input: ForkAgentSession,
  now: number,
): ForkSessionResult {
  validateSessionConfiguration(input.source);
  const sessionId = resources.generateId(now);
  const session = {
    ...input.source,
    autoCompact: input.autoCompact,
    userId: input.userId,
    workspaceId: input.workspaceId,
  };
  resources.database.transaction((transaction) => {
    insertSession(
      transaction,
      storedSessionValues(session, sessionId, now, {
        parentExecutionGeneration: null,
        parentSessionId: null,
        status: "idle",
        title: `Fork of ${input.source.title}`.slice(0, 80),
      }),
    );
    for (const message of input.messages) {
      insertStoredMessage(transaction, forkMessageValues(message), {
        actorId: input.userId,
        id: resources.generateId(now),
        now: message.createdAt,
        segment: 0,
        sessionId,
        userId: input.userId,
      });
    }
  });
  return readStoredSessionResult(
    resources,
    input.userId,
    sessionId,
    "forked",
    "The forked agent session could not be read after creation",
  );
}
