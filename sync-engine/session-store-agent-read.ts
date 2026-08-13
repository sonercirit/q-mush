import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentToolCall } from "../shared/agent-loop.ts";
import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
} from "../shared/session-model.ts";

import { countSelectedRows } from "./database-count.ts";
import { readStoredToolCalls } from "./session-store-read.ts";
import { storedAgentFile } from "./stored-agent-file.ts";

export interface ReadSessionSnapshot {
  readonly agentFile: AgentFile | null;
  readonly executionEnvironment: (typeof agentSessions.$inferSelect)["executionEnvironment"];
  readonly id: string;
  readonly status: AgentSessionStatus;
  readonly title: string;
  readonly tools: NonNullable<ReturnType<typeof readAgentSessionToolNames>>;
  readonly transcript: {
    readonly matchedRecords: number;
    readonly messages: readonly AgentSessionMessage[];
  };
}

type TranscriptRole = "assistant" | "error" | "thinking" | "tool" | "user";

function storedToolCalls(value: string | null): readonly AgentToolCall[] {
  return readStoredToolCalls(value);
}

function isTranscriptRole(
  role: AgentSessionMessage["role"] | null,
): role is TranscriptRole {
  return (
    role === "assistant" ||
    role === "error" ||
    role === "thinking" ||
    role === "tool" ||
    role === "user"
  );
}

interface StoredReadSessionRow {
  readonly content: string | null;
  readonly createdAt: Date | null;
  readonly messageId: string | null;
  readonly toolCalls: string | null;
  readonly role: AgentSessionMessage["role"] | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
}

function transcriptMessages(
  rows: readonly StoredReadSessionRow[],
): readonly AgentSessionMessage[] {
  return [...rows]
    .reverse()
    .flatMap((message): readonly AgentSessionMessage[] =>
      message.messageId !== null &&
      message.createdAt !== null &&
      isTranscriptRole(message.role) &&
      message.content !== null
        ? [
            {
              content: message.content,
              createdAt: message.createdAt.getTime(),
              id: message.messageId,
              images: [],
              role: message.role,
              toolCallId: message.toolCallId,
              toolCalls: storedToolCalls(message.toolCalls),
              toolName: message.toolName,
            },
          ]
        : [],
    );
}

function ownedMessageCondition(
  userId: string,
  roles: readonly TranscriptRole[],
) {
  return and(
    eq(agentMessages.userId, userId),
    eq(agentMessages.isDeleted, false),
    eq(
      agentMessages.segment,
      sql<number>`(SELECT ${agentSessions.currentSegment} FROM ${agentSessions} WHERE ${agentSessions.id} = ${agentMessages.sessionId})`,
    ),
    inArray(agentMessages.role, roles),
  );
}

interface ReadSessionLookup {
  readonly roles: readonly TranscriptRole[];
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId?: string;
}

function sessionMessageCondition(lookup: ReadSessionLookup) {
  return and(
    ownedMessageCondition(lookup.userId, lookup.roles),
    eq(agentMessages.sessionId, lookup.sessionId),
  );
}

function matchedTranscriptRecords(
  database: AppDatabase,
  userId: string,
  sessionId: string,
  roles: readonly TranscriptRole[],
  limit: number,
  rows: readonly { readonly messageId: string | null }[],
): number {
  if (roles.length === 0) {
    return 0;
  }
  if (rows.length < limit) {
    return rows.filter(({ messageId }) => messageId !== null).length;
  }
  return countSelectedRows(
    database,
    agentMessages,
    sessionMessageCondition({ roles, sessionId, userId }),
  );
}

interface ReadSessionSnapshotInput extends ReadSessionLookup {
  readonly includeSystem: boolean;
  readonly limit: number;
}

export function readSessionSnapshot(
  database: AppDatabase,
  input: ReadSessionSnapshotInput,
): ReadSessionSnapshot | undefined {
  const { includeSystem, limit, sessionId, userId } = input;
  const selectedRoles = [...input.roles].sort();
  const rows = database
    .select({
      agentFileContent: includeSystem
        ? sql<
            string | null
          >`CASE WHEN ${agentSessions.agentFileContent} IS NULL THEN NULL ELSE substr(${agentSessions.agentFileContent}, 1, 10001) END`
        : sql<null>`null`,
      agentFileName: includeSystem
        ? agentSessions.agentFileName
        : sql<null>`null`,
      content: sql<string | null>`substr(${agentMessages.content}, 1, 8001)`,
      createdAt: agentMessages.createdAt,
      executionEnvironment: agentSessions.executionEnvironment,
      id: agentSessions.id,
      messageId: agentMessages.id,
      role: agentMessages.role,
      status: agentSessions.status,
      title: agentSessions.title,
      toolCallId: agentMessages.toolCallId,
      toolCalls: agentMessages.toolCalls,
      toolName: agentMessages.toolName,
      tools: agentSessions.tools,
    })
    .from(agentSessions)
    .leftJoin(
      agentMessages,
      selectedRoles.length === 0
        ? sql`false`
        : and(
            ownedMessageCondition(userId, selectedRoles),
            eq(agentMessages.sessionId, agentSessions.id),
          ),
    )
    .where(
      and(
        eq(agentSessions.isDeleted, false),
        eq(agentSessions.userId, userId),
        eq(agentSessions.id, sessionId),
        input.workspaceId === undefined
          ? undefined
          : eq(agentSessions.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .limit(selectedRoles.length === 0 ? 1 : limit)
    .all();
  const stored = rows[0];
  if (stored === undefined) {
    return undefined;
  }
  const tools = readAgentSessionToolNames(JSON.parse(stored.tools));
  if (tools === undefined) {
    throw new Error("Stored agent session tools are invalid");
  }
  return {
    agentFile: storedAgentFile(stored),
    executionEnvironment: stored.executionEnvironment,
    id: stored.id,
    status: stored.status,
    title: stored.title,
    tools,
    transcript: {
      matchedRecords: matchedTranscriptRecords(
        database,
        userId,
        sessionId,
        selectedRoles,
        limit,
        rows,
      ),
      messages: transcriptMessages(rows),
    },
  };
}
