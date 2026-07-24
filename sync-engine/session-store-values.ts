import { eq, sql } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";

const INTERRUPTED_SESSION_ERROR =
  "Session failed: the server stopped before the session completed";

const INTERRUPTED_RUNNER_TOOL_OUTPUT =
  "Error: the runner was removed before this tool call returned a result.";

export interface StoredMessageValues {
  readonly content: string;
  readonly images: string | null;
  readonly role: "assistant" | "error" | "system" | "thinking" | "tool";
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

export function interruptedRunnerToolValues(
  toolCallId: string,
  toolName: string,
): StoredMessageValues {
  return {
    content: INTERRUPTED_RUNNER_TOOL_OUTPUT,
    images: null,
    role: "tool",
    toolCallId,
    toolCalls: null,
    toolName,
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

export function userMessageValues(options: {
  readonly content: string;
  readonly id: string;
  readonly images: readonly AgentImage[];
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}) {
  return {
    ...createdAuditFields(options.userId, options.now),
    content: options.content,
    id: options.id,
    images: options.images.length === 0 ? null : JSON.stringify(options.images),
    role: "user" as const,
    sessionId: options.sessionId,
    userId: options.userId,
  };
}

export interface StoredMessageInsertOptions {
  readonly actorId: string;
  readonly id: string;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}

export function insertStoredMessage(
  database: Pick<AppDatabase, "insert">,
  message: StoredMessageValues,
  options: StoredMessageInsertOptions,
): void {
  database
    .insert(agentMessages)
    .values({
      ...createdAuditFields(options.actorId, options.now),
      ...message,
      id: options.id,
      sessionId: options.sessionId,
      userId: options.userId,
    })
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
    const exists = transaction
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        sql`${agentSessions.id} = ${sessionIdentifier} AND ${agentSessions.userId} = ${userId} AND ${agentSessions.isDeleted} = false`,
      )
      .get();
    if (exists === undefined) {
      return false;
    }
    insertAgentMessage(
      transaction,
      userMessageValues({
        content,
        id: resources.generateId(now),
        images: [],
        now,
        sessionId: sessionIdentifier,
        userId,
      }),
    );
    transaction
      .update(agentSessions)
      .set({ updatedAt: new Date(now), updatedById: SYSTEM_ID })
      .where(eq(agentSessions.id, sessionIdentifier))
      .run();
    return true;
  });
}
