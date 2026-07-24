import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { readAgentFile, type AgentFile } from "../shared/agent-file.ts";
import { readAgentSessionToolNames } from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
} from "../shared/session-model.ts";

export interface ReadSessionSnapshot {
  readonly agentFile: AgentFile | null;
  readonly id: string;
  readonly status: AgentSessionStatus;
  readonly title: string;
  readonly tools: NonNullable<ReturnType<typeof readAgentSessionToolNames>>;
  readonly transcript: {
    readonly matchedRecords: number;
    readonly messages: readonly AgentSessionMessage[];
  };
}

type TranscriptRole = "assistant" | "user";

function transcriptMessages(
  rows: readonly {
    readonly content: string | null;
    readonly createdAt: Date | null;
    readonly messageId: string | null;
    readonly role: AgentSessionMessage["role"] | null;
  }[],
): readonly AgentSessionMessage[] {
  return [...rows]
    .reverse()
    .flatMap((message): readonly AgentSessionMessage[] =>
      message.messageId !== null &&
      message.createdAt !== null &&
      (message.role === "assistant" || message.role === "user") &&
      message.content !== null
        ? [
            {
              content: message.content,
              createdAt: message.createdAt.getTime(),
              id: message.messageId,
              images: [],
              role: message.role,
              toolCallId: null,
              toolCalls: [],
              toolName: null,
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
    inArray(agentMessages.role, roles),
  );
}

interface ReadSessionLookup {
  readonly roles: readonly TranscriptRole[];
  readonly sessionId: string;
  readonly userId: string;
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
  return (
    database
      .select({ value: count() })
      .from(agentMessages)
      .where(sessionMessageCondition({ roles, sessionId, userId }))
      .get()?.value ?? 0
  );
}

function storedAgentFile(stored: {
  readonly agentFileContent: string | null;
  readonly agentFileName: "AGENTS.md" | "CLAUDE.md" | null;
}): AgentFile | null {
  return readAgentFile(
    stored.agentFileContent === null && stored.agentFileName === null
      ? null
      : { content: stored.agentFileContent, name: stored.agentFileName },
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
      id: agentSessions.id,
      messageId: agentMessages.id,
      role: agentMessages.role,
      status: agentSessions.status,
      title: agentSessions.title,
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
