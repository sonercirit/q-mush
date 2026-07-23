import { eq, sql } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";

export interface StoredMessageValues {
  readonly content: string;
  readonly images: string | null;
  readonly role: "assistant" | "system" | "thinking" | "tool";
  readonly toolCallId: string | null;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
}

export interface SessionWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

export function emptyToolMetadata() {
  return {
    images: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
  };
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
    transaction
      .insert(agentMessages)
      .values(
        userMessageValues({
          content,
          id: resources.generateId(now),
          images: [],
          now,
          sessionId: sessionIdentifier,
          userId,
        }),
      )
      .run();
    transaction
      .update(agentSessions)
      .set({ updatedAt: new Date(now), updatedById: SYSTEM_ID })
      .where(eq(agentSessions.id, sessionIdentifier))
      .run();
    return true;
  });
}
