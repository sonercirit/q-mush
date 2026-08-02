import { and, asc, eq } from "drizzle-orm";
import {
  readAgentToolCalls,
  type AgentConversationMessage,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type { IdGenerator } from "../shared/ids.ts";
import {
  readProviderModelPricing,
  type ProviderModelPricing,
} from "../shared/provider-model-pricing.ts";
import { compareAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { STORED_SESSION_MESSAGE_SELECTION } from "./session-message-selection.ts";
import { sessionSegmentQuery } from "./session-segment.ts";
import { readStoredSessionUserId } from "./session-store-state.ts";
import { appendSystemMessageAndTouchSession } from "./session-store-values.ts";
import { parseStoredImages } from "./stored-agent-images.ts";

export function readStoredToolCalls(
  value: string | null,
): readonly AgentToolCall[] {
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
  "createdAt" | "images" | "tokenUsage" | "toolCalls"
> & {
  readonly cacheWriteInputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly createdAt: Date;
  readonly images: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: string | null;
};

export function summarizeStoredMessage(
  stored: StoredMessage,
): AgentSessionMessage {
  const parsedAttachments = parseStoredImages(
    stored.images,
    "Stored agent attachments are invalid",
  );
  const {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    ...fields
  } = stored;
  const usageValues = [
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
  ];
  const tokenUsage = usageValues.every((value) => value === null)
    ? null
    : usageValues.every((value) => value !== null)
      ? {
          cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
          cachedInputTokens: cachedInputTokens ?? 0,
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
        }
      : undefined;
  if (tokenUsage === undefined) {
    throw new Error("Stored agent token usage is invalid");
  }
  return {
    ...fields,
    createdAt: stored.createdAt.getTime(),
    images: parsedAttachments,
    ...(tokenUsage === null ? {} : { tokenUsage }),
    toolCalls: readStoredToolCalls(stored.toolCalls),
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

export type InterruptedRunnerToolOptions = Readonly<{
  database: Pick<AppDatabase, "insert" | "select" | "update">;
  generateId: IdGenerator;
  now: number;
  sessionId: string;
}>;

function appendInterruptedToolResults(
  options: InterruptedRunnerToolOptions,
  output: string,
): void {
  const append = (
    database: Pick<AppDatabase, "insert" | "select" | "update">,
  ): void => {
    const messages = readStoredSessionMessages(database, options.sessionId);
    const calls = [...trackedToolCalls(messages).values()];
    if (calls.length === 0) {
      return;
    }
    const userId = readStoredSessionUserId(
      database,
      eq(agentSessions.id, options.sessionId),
    );
    if (userId === undefined) {
      throw new Error("The agent session no longer exists");
    }
    for (const call of calls) {
      appendSystemMessageAndTouchSession({
        condition: eq(agentSessions.id, options.sessionId),
        database,
        generateId: options.generateId,
        message: {
          content: output,
          images: null,
          role: "tool",
          toolCallId: call.id,
          toolCalls: null,
          toolName: call.name,
        },
        now: options.now,
        sessionId: options.sessionId,
        userId,
      });
    }
  };
  append(options.database);
}

const UNKNOWN_RESTART_TOOL_OUTPUT =
  "Error: this tool call was interrupted by a restart after dispatch; its external outcome is unknown. Inspect the target state before deciding whether it is safe to retry.";

export function appendUnknownRestartToolResults(
  options: InterruptedRunnerToolOptions,
): void {
  appendInterruptedToolResults(options, UNKNOWN_RESTART_TOOL_OUTPUT);
}

export function appendInterruptedRunnerToolResult(
  options: Omit<InterruptedRunnerToolOptions, "database"> & {
    readonly database: AppDatabase;
  },
): void {
  options.database.transaction((transaction) => {
    appendInterruptedToolResults(
      { ...options, database: transaction },
      "Error: the runner was removed before this tool call returned a result.",
    );
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
      case "compaction_request":
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
    .select(STORED_SESSION_MESSAGE_SELECTION)
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.isDeleted, false),
        eq(agentMessages.sessionId, sessionId),
        eq(
          agentMessages.segment,
          sessionSegmentQuery(database, eq(agentSessions.id, sessionId)),
        ),
      ),
    )
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
    .all()
    .map(summarizeStoredMessage)
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
      case "user": {
        const attachments = message.attachments ?? message.images;
        conversation.push({
          content: message.content,
          ...(attachments.length === 0 ? {} : { images: attachments }),
          role: "user",
        });
        break;
      }
      case "compaction_request":
      case "error":
      case "system":
      case "thinking":
        break;
    }
  }
  return conversation;
}

export function serializeProviderPricing(
  pricing: ProviderModelPricing | null,
): string | null {
  return pricing === null ? null : JSON.stringify(pricing);
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
