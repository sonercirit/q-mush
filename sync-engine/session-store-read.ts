import { and, asc, eq } from "drizzle-orm";
import { readAgentImages, type AgentImage } from "../shared/agent-images.ts";
import {
  readAgentToolCalls,
  type AgentConversationMessage,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { readProviderModelPricing } from "../shared/provider-model-pricing.ts";
import { compareAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";

function parseToolCalls(value: string | null): readonly AgentToolCall[] {
  if (value === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return readAgentToolCalls(parsed, "A stored agent tool call is invalid");
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent tool calls are invalid");
}

type StoredMessage = Omit<
  AgentSessionMessage,
  "createdAt" | "images" | "toolCalls"
> & {
  readonly createdAt: Date;
  readonly images: string | null;
  readonly toolCalls: string | null;
};

function parseImages(value: string | null): readonly AgentImage[] {
  if (value === null) {
    return [];
  }
  try {
    const images = readAgentImages(JSON.parse(value));
    if (images !== undefined) {
      return images;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent images are invalid");
}

function summarizeMessage(stored: StoredMessage): AgentSessionMessage {
  return {
    ...stored,
    createdAt: stored.createdAt.getTime(),
    images: parseImages(stored.images),
    toolCalls: parseToolCalls(stored.toolCalls),
  };
}

const INTERRUPTED_TOOL_OUTPUT =
  "Error: the tool call was interrupted before it returned a result.";

interface PendingToolResult {
  readonly call: AgentToolCall;
  readonly createdAt: number;
  readonly messageId: string;
}

function interruptedToolResult(
  pending: PendingToolResult,
): AgentSessionMessage {
  return {
    content: INTERRUPTED_TOOL_OUTPUT,
    createdAt: pending.createdAt,
    id: `${pending.messageId}:interrupted:${pending.call.id}`,
    images: [],
    role: "tool",
    toolCallId: pending.call.id,
    toolCalls: [],
    toolName: pending.call.name,
  };
}

export function withInterruptedToolResults(
  messages: readonly AgentSessionMessage[],
  finishTrailingCalls: boolean,
): readonly AgentSessionMessage[] {
  const complete: AgentSessionMessage[] = [];
  let pending: readonly PendingToolResult[] = [];
  const finishPending = () => {
    complete.push(...pending.map(interruptedToolResult));
    pending = [];
  };

  for (const message of messages) {
    switch (message.role) {
      case "assistant":
        finishPending();
        complete.push(message);
        pending = message.toolCalls.map((call) => ({
          call,
          createdAt: message.createdAt,
          messageId: message.id,
        }));
        break;
      case "tool":
        complete.push(message);
        pending = pending.filter(({ call }) => call.id !== message.toolCallId);
        break;
      case "user":
        finishPending();
        complete.push(message);
        break;
      case "error":
      case "system":
      case "thinking":
        complete.push(message);
        break;
    }
  }
  if (finishTrailingCalls) {
    finishPending();
  }
  return complete;
}

export function sessionSelection() {
  return {
    activeDurationMs: agentSessions.activeDurationMs,
    activeStartedAt: agentSessions.activeStartedAt,
    autoCompact: agentSessions.autoCompact,
    costBasis: agentSessions.costBasis,
    costUsd: agentSessions.costUsd,
    createdAt: agentSessions.createdAt,
    credentialId: agentSessions.providerCredentialId,
    currentContextTokens: agentSessions.currentContextTokens,
    executionEnvironment: agentSessions.executionEnvironment,
    id: agentSessions.id,
    maxContextTokens: agentSessions.maxContextTokens,
    model: agentSessions.model,
    provider: agentSessions.provider,
    providerPricing: agentSessions.providerPricing,
    reasoningEffort: agentSessions.reasoningEffort,
    runnerId: agentSessions.runnerId,
    status: agentSessions.status,
    title: agentSessions.title,
    tools: agentSessions.tools,
    updatedAt: agentSessions.updatedAt,
    workingDirectory: agentSessions.workingDirectory,
  };
}

type StoredSessionSummary = Pick<
  typeof agentSessions.$inferSelect,
  | "activeDurationMs"
  | "activeStartedAt"
  | "autoCompact"
  | "costBasis"
  | "costUsd"
  | "createdAt"
  | "currentContextTokens"
  | "executionEnvironment"
  | "id"
  | "maxContextTokens"
  | "model"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "runnerId"
  | "status"
  | "title"
  | "tools"
  | "updatedAt"
  | "workingDirectory"
> & { readonly credentialId: string };

function parseStoredTools(value: string): readonly AgentSessionToolName[] {
  try {
    const tools = readAgentSessionToolNames(JSON.parse(value));
    if (tools !== undefined) {
      return tools;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent session tools are invalid");
}

export function summarizeSession(
  stored: StoredSessionSummary,
): AgentSessionSummary {
  return {
    ...stored,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerPricing: parseProviderPricing(stored.providerPricing),
    tools: parseStoredTools(stored.tools),
    updatedAt: stored.updatedAt.getTime(),
  };
}

export function storedSessionMessages(
  database: AppDatabase,
  sessionId: string,
): readonly AgentSessionMessage[] {
  return database
    .select({
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
      id: agentMessages.id,
      images: agentMessages.images,
      role: agentMessages.role,
      toolCallId: agentMessages.toolCallId,
      toolCalls: agentMessages.toolCalls,
      toolName: agentMessages.toolName,
    })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.isDeleted, false),
        eq(agentMessages.sessionId, sessionId),
      ),
    )
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
    .all()
    .map(summarizeMessage)
    .sort(compareAgentSessionMessages);
}

export function conversationFromMessages(
  messages: readonly AgentSessionMessage[],
): readonly AgentConversationMessage[] {
  const conversation: AgentConversationMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "assistant":
        conversation.push({
          content: message.content,
          role: "assistant",
          toolCalls: message.toolCalls,
        });
        break;
      case "tool":
        if (message.toolCallId === null || message.toolName === null) {
          throw new Error("A stored tool result has no tool identity");
        }
        conversation.push({
          content: message.content,
          role: "tool",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
        });
        break;
      case "user":
        conversation.push({
          content: message.content,
          ...(message.images.length === 0 ? {} : { images: message.images }),
          role: "user",
        });
        break;
      case "error":
      case "system":
      case "thinking":
        break;
    }
  }
  return conversation;
}

function parseProviderPricing(
  value: string | null,
): AgentSessionSummary["providerPricing"] {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const pricing = readProviderModelPricing(parsed);
    if (pricing !== undefined) {
      return pricing;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored provider pricing is invalid");
}
