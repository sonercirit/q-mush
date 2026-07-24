import { and, asc, eq } from "drizzle-orm";
import { readAgentImages, type AgentImage } from "../shared/agent-images.ts";
import {
  readAgentToolCalls,
  type AgentConversationMessage,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { readProviderModelPricing } from "../shared/provider-model-pricing.ts";
import { compareAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  insertStoredMessage,
  interruptedRunnerToolValues,
} from "./session-store-values.ts";

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

function trackedToolCalls(
  messages: readonly AgentSessionMessage[],
): ReadonlyMap<string, AgentToolCall> {
  const pending = new Map<string, AgentToolCall>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId !== null) {
      pending.delete(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls) {
      pending.set(call.id, call);
    }
  }
  return pending;
}

function firstUnresolvedToolCall(
  messages: readonly AgentSessionMessage[],
): AgentToolCall | undefined {
  return trackedToolCalls(messages).values().next().value;
}

export type InterruptedRunnerToolOptions = Readonly<{
  database: AppDatabase;
  generateId: IdGenerator;
  now: number;
  sessionId: string;
}>;

export function appendInterruptedRunnerToolResult(
  options: InterruptedRunnerToolOptions,
): void {
  options.database.transaction((transaction) => {
    const messages = readStoredSessionMessages(transaction, options.sessionId);
    const call = firstUnresolvedToolCall(messages);
    if (call === undefined) {
      return;
    }
    const session = transaction
      .select({ userId: agentSessions.userId })
      .from(agentSessions)
      .where(eq(agentSessions.id, options.sessionId))
      .get();
    if (session === undefined) {
      throw new Error("The agent session no longer exists");
    }
    insertStoredMessage(
      transaction,
      interruptedRunnerToolValues(call.id, call.name),
      {
        actorId: SYSTEM_ID,
        id: options.generateId(options.now),
        now: options.now,
        sessionId: options.sessionId,
        userId: session.userId,
      },
    );
    transaction
      .update(agentSessions)
      .set(updatedAuditFields(SYSTEM_ID, options.now))
      .where(eq(agentSessions.id, options.sessionId))
      .run();
  });
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

export function readStoredSessionMessages(
  database: Pick<AppDatabase, "select">,
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

export function parseProviderPricing(
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
