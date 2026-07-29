import { desc } from "drizzle-orm";
import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { userSessionFilter } from "./session-filter.ts";
import { storedPendingInputs } from "./session-pending-inputs.ts";
import { storedSessionAgentFile } from "./session-store-agent-file.ts";
import {
  readStoredSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";
import {
  selectStoredSessions,
  summarizeStoredSession,
} from "./session-store-summary.ts";
import { readSessionTurns } from "./session-turn-store.ts";

type ReadPendingQuestions = (
  userId: string,
  sessionId: string,
) => PendingAskQuestions | null;

export function readStoredSessionDetail(
  database: AppDatabase,
  readPendingQuestions: ReadPendingQuestions,
  userId: string,
  sessionId: string,
  workspaceId?: string,
): AgentSessionDetail | undefined {
  const stored = selectStoredSessions(
    database,
    userSessionFilter(userId, sessionId, workspaceId),
  ).get();
  if (stored === undefined) {
    return undefined;
  }

  return {
    ...summarizeStoredSession(stored),
    pendingQuestions: readPendingQuestions(userId, sessionId),
    agentFile: storedSessionAgentFile(database, sessionId),
    messages: withInterruptedToolResults(
      readStoredSessionMessages(database, sessionId),
      stored.status !== "queued" &&
        stored.status !== "running" &&
        stored.status !== "paused",
    ),
    pendingInputs: storedPendingInputs(database, sessionId),
    turns: readSessionTurns(database, sessionId),
  };
}

export function listStoredSessions(
  database: AppDatabase,
  readPendingQuestions: ReadPendingQuestions,
  userId: string,
  workspaceId?: string,
): readonly AgentSessionSummary[] {
  return selectStoredSessions(
    database,
    userSessionFilter(userId, undefined, workspaceId),
  )
    .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
    .all()
    .map((stored) => {
      const summary = summarizeStoredSession(stored);
      return {
        ...summary,
        pendingQuestions: readPendingQuestions(userId, summary.id),
      };
    });
}
