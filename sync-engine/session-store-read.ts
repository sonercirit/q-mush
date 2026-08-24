import { and, eq, type SQL } from "drizzle-orm";
import {
  readAgentToolCalls,
  truncationFromNotice,
  type AgentConversationMessage,
  type AgentProviderReplay,
  type AgentStepTruncation,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import { parseAnthropicAssistantReplay } from "../shared/anthropic-replay.ts";
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
import {
  anthropicReplayMatchesIdentity,
  type AnthropicReplayIdentity,
} from "./anthropic-replay-identity.ts";
import {
  INTERNAL_SESSION_MESSAGE_SELECTION,
  STORED_SESSION_MESSAGE_SELECTION,
} from "./session-message-selection.ts";
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

type InternalStoredMessage = StoredMessage & {
  readonly providerReplay: string | null;
};

export interface InternalSessionMessage {
  readonly message: AgentSessionMessage;
  readonly providerReplay?: AgentProviderReplay;
}

function storedProviderReplay(
  value: string | null,
  role: AgentSessionMessage["role"],
): AgentProviderReplay | undefined {
  if (role === "assistant") {
    try {
      return parseAnthropicAssistantReplay(value);
    } catch {
      // Replay is private optimization metadata. Corruption must not make the
      // public transcript, session continuation, or fork unreadable, but it
      // must remain observable for repair instead of disappearing silently.
      console.warn(
        "Ignored corrupt Anthropic replay metadata on a stored assistant message",
      );
      return undefined;
    }
  }
  return undefined;
}

function summarizeInternalStoredMessage(
  stored: InternalStoredMessage,
): InternalSessionMessage {
  const { providerReplay, ...publicFields } = stored;
  const message = summarizeStoredMessage(publicFields);
  const replay = storedProviderReplay(providerReplay, message.role);
  return {
    message,
    ...(replay === undefined ? {} : { providerReplay: replay }),
  };
}

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
  return withInterruptedInternalToolResults(
    messages.map((message) => ({ message })),
    finishTrailingCalls,
  ).map(({ message }) => message);
}

function interruptedInternalToolResult(
  pending: PendingToolResult,
): InternalSessionMessage {
  return { message: interruptedToolResult(pending) };
}

export function withInterruptedInternalToolResults(
  messages: readonly InternalSessionMessage[],
  finishTrailingCalls: boolean,
): readonly InternalSessionMessage[] {
  const complete: InternalSessionMessage[] = [];
  let pending: readonly PendingToolResult[] = [];
  const finishPending = () => {
    complete.push(...pending.map(interruptedInternalToolResult));
    pending = [];
  };

  for (const internal of messages) {
    const { message } = internal;
    const handlers: Record<AgentSessionMessage["role"], () => void> = {
      assistant: () => {
        finishPending();
        complete.push(internal);
        pending = message.toolCalls.map((call) => ({
          call,
          createdAt: message.createdAt,
          messageId: message.id,
        }));
      },
      tool: () => {
        complete.push(internal);
        pending = pending.filter(({ call }) => call.id !== message.toolCallId);
      },
      user: () => {
        finishPending();
        complete.push(internal);
      },
      compaction_request: () => complete.push(internal),
      error: () => complete.push(internal),
      system: () => complete.push(internal),
      thinking: () => complete.push(internal),
    };
    handlers[message.role]();
  }
  if (finishTrailingCalls) {
    finishPending();
  }
  return complete;
}

function currentSegmentMessageCondition(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
) {
  return and(
    eq(agentMessages.isDeleted, false),
    eq(agentMessages.sessionId, sessionId),
    eq(
      agentMessages.segment,
      sessionSegmentQuery(database, eq(agentSessions.id, sessionId)),
    ),
  );
}

function currentSegmentMessages<Result>(
  query: { where(condition: SQL | undefined): Result },
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): Result {
  return query.where(currentSegmentMessageCondition(database, sessionId));
}

function messageQueryBuilders(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
) {
  return {
    internal: () =>
      currentSegmentMessages(
        database.select(INTERNAL_SESSION_MESSAGE_SELECTION).from(agentMessages),
        database,
        sessionId,
      ),
    stored: () =>
      currentSegmentMessages(
        database.select(STORED_SESSION_MESSAGE_SELECTION).from(agentMessages),
        database,
        sessionId,
      ),
  };
}

export function readInternalSessionMessages(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly InternalSessionMessage[] {
  const internal: readonly InternalStoredMessage[] = messageQueryBuilders(
    database,
    sessionId,
  )
    .internal()
    .all();
  const summarized = internal.map(summarizeInternalStoredMessage);
  return summarized.sort((left, right) =>
    compareAgentSessionMessages(left.message, right.message),
  );
}

export function readStoredSessionMessages(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly AgentSessionMessage[] {
  const stored: readonly StoredMessage[] = messageQueryBuilders(
    database,
    sessionId,
  )
    .stored()
    .all();
  return stored.map(summarizeStoredMessage).sort(compareAgentSessionMessages);
}

export function storedConversationTruncation(
  messages: readonly AgentSessionMessage[],
): AgentStepTruncation | undefined {
  const trailing = messages.at(-1);
  return trailing?.role === "error"
    ? truncationFromNotice(trailing.content)
    : undefined;
}

function replayForIdentity(
  internal: InternalSessionMessage,
  identity: AnthropicReplayIdentity,
): InternalSessionMessage {
  return internal.providerReplay === undefined ||
    anthropicReplayMatchesIdentity(internal.providerReplay, identity)
    ? internal
    : { message: internal.message };
}

export function conversationFromInternalMessages(
  messages: readonly InternalSessionMessage[],
  identity?: AnthropicReplayIdentity,
): readonly AgentConversationMessage[] {
  const conversation: AgentConversationMessage[] = [];
  for (const source of messages) {
    const internal =
      identity === undefined
        ? { message: source.message }
        : replayForIdentity(source, identity);
    const message = internal.message;
    const handlers: Record<AgentSessionMessage["role"], () => void> = {
      assistant: () => {
        conversation.push({
          content: message.content,
          ...(internal.providerReplay === undefined
            ? {}
            : { providerReplay: internal.providerReplay }),
          role: "assistant",
          toolCalls: message.toolCalls,
        });
      },
      tool: () => {
        if (message.toolCallId === null || message.toolName === null) {
          throw new Error("A stored tool result has no tool identity");
        }
        conversation.push({
          content: message.content,
          role: "tool",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
        });
      },
      user: () => {
        const attachments = message.attachments ?? message.images;
        conversation.push({
          content: message.content,
          ...(attachments.length === 0 ? {} : { images: attachments }),
          role: "user",
        });
      },
      compaction_request: () => undefined,
      error: () => undefined,
      system: () => undefined,
      thinking: () => undefined,
    };
    handlers[message.role]();
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
