import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentRecordedMessage,
  AgentTokenUsage,
} from "../shared/agent-loop.ts";
import { serializeAnthropicAssistantReplay } from "../shared/anthropic-replay.ts";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { currentSessionSegment } from "./session-segment.ts";
import type {
  StoredMessageInsertOptions,
  StoredUserMessageInput,
  SystemStoredMessageInput,
} from "./session-store-types.ts";
import { touchStoredSession } from "./session-touch.ts";
import { activeSessionTurnId } from "./session-turn-store.ts";
import { serializeStoredImages } from "./stored-agent-images.ts";

const INTERRUPTED_SESSION_ERROR =
  "Session failed: the server stopped before the session completed";

export interface StoredMessageValues {
  readonly content: string;
  readonly images: string | null;
  readonly providerReplay?: string | null;
  readonly role:
    | "assistant"
    | "compaction_request"
    | "error"
    | "system"
    | "thinking"
    | "tool"
    | "user";
  readonly toolCallId: string | null;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
  readonly tokenUsage?: AgentTokenUsage | null;
  readonly turnId?: string | null;
}

export interface SessionWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

function emptyToolMetadata() {
  return {
    images: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
  };
}

function storedNoteMessageValues(
  content: string,
  role: "compaction_request" | "error" | "system",
): StoredMessageValues {
  return { ...emptyToolMetadata(), content, role };
}

export function errorMessageValues(content: string): StoredMessageValues {
  return storedNoteMessageValues(content, "error");
}

export function storedCompactionRequestValues(
  content: string,
): StoredMessageValues {
  return storedNoteMessageValues(content, "compaction_request");
}

export function storedSystemMessageValues(
  content: string,
): StoredMessageValues {
  return storedNoteMessageValues(content, "system");
}

export function storedUserMessageValues(
  content: string,
  images: readonly AgentImage[] = [],
): StoredMessageValues {
  return {
    ...emptyToolMetadata(),
    content,
    images: serializeStoredImages(images),
    role: "user",
  };
}

export function interruptedSessionErrorValues(): StoredMessageValues {
  return errorMessageValues(INTERRUPTED_SESSION_ERROR);
}

export function recordedMessageValues(
  message: AgentRecordedMessage,
  tokenUsage?: AgentTokenUsage | null,
): StoredMessageValues {
  if (message.role === "assistant") {
    return {
      ...emptyToolMetadata(),
      content: message.content,
      providerReplay: serializeAnthropicAssistantReplay(message.providerReplay),
      role: "assistant",
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      toolCalls: JSON.stringify(message.toolCalls),
    };
  }
  if (message.role === "tool") {
    return {
      content: message.content,
      images: null,
      role: "tool",
      toolCallId: message.toolCallId,
      toolCalls: null,
      toolName: message.toolName,
    };
  }
  return {
    ...emptyToolMetadata(),
    content: message.content,
    role: message.role,
  };
}

export function userMessageValues(
  options: StoredUserMessageInput & {
    readonly id: string;
    readonly images: readonly AgentImage[];
  },
) {
  return {
    ...createdAuditFields(options.userId, options.now),
    content: options.content,
    id: options.id,
    images: serializeStoredImages(options.images),
    role: "user" as const,
    segment: options.segment ?? 0,
    sessionId: options.sessionId,
    turnId: options.turnId ?? null,
    userId: options.userId,
  };
}

function systemMessageInsertOptions(
  generateId: IdGenerator,
  now: number,
  sessionId: string,
  userId: string,
): StoredMessageInsertOptions {
  return {
    actorId: SYSTEM_ID,
    id: generateId(now),
    now,
    sessionId,
    userId,
  };
}

function requiredStoredMessageSegment(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  segment: number | undefined,
): number {
  const resolved = segment ?? currentSessionSegment(database, sessionId);
  if (resolved === undefined) {
    throw new Error("The agent session no longer exists");
  }
  return resolved;
}

export function nextStoredMessageTimestamp(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  segment: number,
  now: number,
): number {
  const latest = database
    .select({
      createdAt: sql<number | null>`max(${agentMessages.createdAt})`,
    })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.sessionId, sessionId),
        eq(agentMessages.segment, segment),
        eq(agentMessages.isDeleted, false),
      ),
    )
    .get()?.createdAt;
  return latest === null || latest === undefined
    ? now
    : Math.max(now, latest + 1);
}

export function insertStoredMessage(
  database: Pick<AppDatabase, "insert" | "select">,
  message: StoredMessageValues,
  options: StoredMessageInsertOptions,
): void {
  const segment = requiredStoredMessageSegment(
    database,
    options.sessionId,
    options.segment,
  );
  database
    .insert(agentMessages)
    .values({
      ...createdAuditFields(options.actorId, options.now),
      ...message,
      ...(message.tokenUsage === undefined || message.tokenUsage === null
        ? {}
        : {
            cacheWriteInputTokens: message.tokenUsage.cacheWriteInputTokens,
            cachedInputTokens: message.tokenUsage.cachedInputTokens,
            inputTokens: message.tokenUsage.inputTokens,
            outputTokens: message.tokenUsage.outputTokens,
          }),
      id: options.id,
      segment,
      sessionId: options.sessionId,
      turnId:
        message.turnId ?? activeSessionTurnId(database, options.sessionId),
      userId: options.userId,
    })
    .run();
}

interface SystemStoredMessageOptions extends SystemStoredMessageInput {
  readonly database: Pick<AppDatabase, "insert" | "select">;
  readonly generateId: IdGenerator;
  readonly message: StoredMessageValues;
}

export function appendSystemStoredMessage(
  options: SystemStoredMessageOptions,
): number {
  const segment = requiredStoredMessageSegment(
    options.database,
    options.sessionId,
    options.segment,
  );
  const messageNow = nextStoredMessageTimestamp(
    options.database,
    options.sessionId,
    segment,
    options.now,
  );
  insertStoredMessage(options.database, options.message, {
    ...systemMessageInsertOptions(
      options.generateId,
      messageNow,
      options.sessionId,
      options.userId,
    ),
    segment,
  });
  return messageNow;
}

export function appendSystemMessageAndTouchSession(
  options: SystemStoredMessageOptions & {
    readonly condition: SQL | undefined;
    readonly database: Pick<AppDatabase, "insert" | "select" | "update">;
  },
): void {
  const messageNow = appendSystemStoredMessage(options);
  options.database
    .update(agentSessions)
    .set(updatedAuditFields(SYSTEM_ID, messageNow))
    .where(options.condition)
    .run();
}

function insertAgentMessage(
  database: Pick<AppDatabase, "insert">,
  values: typeof agentMessages.$inferInsert,
): void {
  database.insert(agentMessages).values(values).run();
}

export function appendSessionUserMessage(options: {
  readonly resources: SessionWriteResources;
  readonly userId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly now: number;
}): boolean {
  const { content, now, resources, sessionId, userId } = options;
  const sessionIdentifier = sessionId;
  return resources.database.transaction((transaction) => {
    const stored = transaction
      .select({ segment: agentSessions.currentSegment })
      .from(agentSessions)
      .where(
        sql`${agentSessions.id} = ${sessionIdentifier} AND ${agentSessions.userId} = ${userId} AND ${agentSessions.isDeleted} = false`,
      )
      .get();
    if (stored === undefined) {
      return false;
    }
    insertAgentMessage(
      transaction,
      userMessageValues({
        content,
        id: resources.generateId(now),
        images: [],
        now,
        segment: stored.segment,
        sessionId: sessionIdentifier,
        userId,
      }),
    );
    touchStoredSession(
      transaction,
      eq(agentSessions.id, sessionIdentifier),
      SYSTEM_ID,
      now,
    );
    return true;
  });
}
