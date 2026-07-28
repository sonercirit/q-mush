import { eq, sql, type SQL } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
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
import { serializeStoredImages } from "./stored-agent-images.ts";

const INTERRUPTED_SESSION_ERROR =
  "Session failed: the server stopped before the session completed";

export interface StoredMessageValues {
  readonly content: string;
  readonly images: string | null;
  readonly role:
    "assistant" | "error" | "system" | "thinking" | "tool" | "user";
  readonly toolCallId: string | null;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
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

export function errorMessageValues(content: string): StoredMessageValues {
  return { ...emptyToolMetadata(), content, role: "error" };
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
): StoredMessageValues {
  if (message.role === "assistant") {
    return {
      ...emptyToolMetadata(),
      content: message.content,
      role: "assistant",
      toolCalls: JSON.stringify(message.toolCalls),
    };
  }
  if (message.role === "thinking") {
    return {
      ...emptyToolMetadata(),
      content: message.content,
      role: "thinking",
    };
  }
  return {
    content: message.content,
    images: null,
    role: "tool",
    toolCallId: message.toolCallId,
    toolCalls: null,
    toolName: message.toolName,
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

export function insertStoredMessage(
  database: Pick<AppDatabase, "insert" | "select">,
  message: StoredMessageValues,
  options: StoredMessageInsertOptions,
): void {
  const segment =
    options.segment ?? currentSessionSegment(database, options.sessionId);

  if (segment === undefined) {
    throw new Error("The agent session no longer exists");
  }
  database
    .insert(agentMessages)
    .values({
      ...createdAuditFields(options.actorId, options.now),
      ...message,
      id: options.id,
      segment,
      sessionId: options.sessionId,
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
): void {
  insertStoredMessage(options.database, options.message, {
    ...systemMessageInsertOptions(
      options.generateId,
      options.now,
      options.sessionId,
      options.userId,
    ),
    ...(options.segment === undefined ? {} : { segment: options.segment }),
  });
}

export function appendSystemMessageAndTouchSession(
  options: SystemStoredMessageOptions & {
    readonly condition: SQL | undefined;
    readonly database: Pick<AppDatabase, "insert" | "select" | "update">;
  },
): void {
  appendSystemStoredMessage(options);
  options.database
    .update(agentSessions)
    .set(updatedAuditFields(SYSTEM_ID, options.now))
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
