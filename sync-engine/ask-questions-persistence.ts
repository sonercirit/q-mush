import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentQuestionRequests,
  agentSessions,
} from "../shared/database/schema.ts";
import type {
  AskQuestionsPersistence,
  AskQuestionsPersistenceTransaction,
  QuestionToolResult,
  StoredQuestionRequest,
  StoredQuestionSession,
} from "./ask-questions-store.ts";
import { nullableColumnCondition } from "./database-condition.ts";
import { exactlyOneUpdatedRow } from "./database-update.ts";
import { storedActiveSessionState } from "./session-active-query.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import { runnerSessionCondition } from "./session-runner-condition.ts";
import { activeSessionCondition } from "./session-store-persistence.ts";
import { insertStoredMessage } from "./session-store-values.ts";

type QuestionDatabase = Pick<AppDatabase, "insert" | "select" | "update">;
type StoredDatabaseQuestionRequest = typeof agentQuestionRequests.$inferSelect;
type StoredDatabaseQuestionSession = Pick<
  typeof agentSessions.$inferSelect,
  | "activeDurationMs"
  | "activeStartedAt"
  | "stepStartedAt"
  | "executionGeneration"
  | "id"
  | "interruptedHandoff"
  | "isDeleted"
  | "status"
  | "updatedAt"
  | "updatedById"
  | "userId"
>;

const QUESTION_SELECTION = {
  answeredAt: agentQuestionRequests.answeredAt,
  answers: agentQuestionRequests.answers,
  createdAt: agentQuestionRequests.createdAt,
  createdById: agentQuestionRequests.createdById,
  executionGeneration: agentQuestionRequests.executionGeneration,
  id: agentQuestionRequests.id,
  isDeleted: agentQuestionRequests.isDeleted,
  questions: agentQuestionRequests.questions,
  sessionId: agentQuestionRequests.sessionId,
  toolCallId: agentQuestionRequests.toolCallId,
  updatedAt: agentQuestionRequests.updatedAt,
  updatedById: agentQuestionRequests.updatedById,
  userId: agentQuestionRequests.userId,
};

function storedQuestionRequest(
  request: StoredDatabaseQuestionRequest,
): StoredQuestionRequest {
  return {
    ...request,
    answeredAt: request.answeredAt?.getTime() ?? null,
    createdAt: request.createdAt.getTime(),
    updatedAt: request.updatedAt.getTime(),
  };
}

function storedQuestionSession(
  session: StoredDatabaseQuestionSession,
): StoredQuestionSession {
  return {
    ...session,
    activeStartedAt: session.activeStartedAt?.getTime() ?? null,
    stepStartedAt: session.stepStartedAt?.getTime() ?? null,
    updatedAt: session.updatedAt.getTime(),
  };
}

function nullableDateCondition(
  column: typeof agentQuestionRequests.answeredAt,
  value: number | null,
) {
  return value === null ? isNull(column) : eq(column, new Date(value));
}

function auditUpdateValues(update: {
  readonly isDeleted?: boolean;
  readonly updatedAt?: number;
  readonly updatedById?: string;
}) {
  return {
    ...(update.isDeleted === undefined ? {} : { isDeleted: update.isDeleted }),
    ...(update.updatedAt === undefined
      ? {}
      : { updatedAt: new Date(update.updatedAt) }),
    ...(update.updatedById === undefined
      ? {}
      : { updatedById: update.updatedById }),
  };
}

function requestUpdateValues(update: Partial<StoredQuestionRequest>) {
  return {
    ...auditUpdateValues(update),
    ...(update.answeredAt === undefined
      ? {}
      : {
          answeredAt:
            update.answeredAt === null ? null : new Date(update.answeredAt),
        }),
    ...(update.answers === undefined ? {} : { answers: update.answers }),
  };
}

function nullableDate(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function sessionUpdateValues(
  update: Partial<StoredQuestionSession>,
): Partial<typeof agentSessions.$inferInsert> {
  return {
    ...auditUpdateValues(update),
    ...(update.activeDurationMs === undefined
      ? {}
      : { activeDurationMs: update.activeDurationMs }),
    ...(update.activeStartedAt === undefined
      ? {}
      : { activeStartedAt: nullableDate(update.activeStartedAt) }),
    ...(update.stepStartedAt === undefined
      ? {}
      : { stepStartedAt: nullableDate(update.stepStartedAt) }),
    ...(update.interruptedHandoff === undefined
      ? {}
      : { interruptedHandoff: update.interruptedHandoff }),
    ...(update.status === undefined ? {} : { status: update.status }),
  };
}

function findQuestion(
  query: () => StoredDatabaseQuestionRequest | undefined,
): StoredQuestionRequest | undefined {
  const request = query();
  return request === undefined ? undefined : storedQuestionRequest(request);
}

function activeQuestionCondition(userId: string, sessionId: string) {
  return and(
    eq(agentQuestionRequests.userId, userId),
    eq(agentQuestionRequests.sessionId, sessionId),
    eq(agentQuestionRequests.isDeleted, false),
  );
}

function drizzleQuestionTransaction(
  database: QuestionDatabase,
): AskQuestionsPersistenceTransaction {
  const questions = () =>
    database.select(QUESTION_SELECTION).from(agentQuestionRequests);
  return {
    findActiveQuestionRequest: (userId, sessionId) =>
      findQuestion(() =>
        questions().where(activeQuestionCondition(userId, sessionId)).get(),
      ),
    findPendingQuestionRequest: (userId, sessionId) =>
      findQuestion(() =>
        questions()
          .where(
            and(
              activeQuestionCondition(userId, sessionId),
              isNull(agentQuestionRequests.answeredAt),
            ),
          )
          .get(),
      ),
    findQuestionRequest: (sessionId, toolCallId) =>
      findQuestion(() =>
        questions()
          .where(
            and(
              eq(agentQuestionRequests.sessionId, sessionId),
              eq(agentQuestionRequests.toolCallId, toolCallId),
            ),
          )
          .get(),
      ),
    findQuestionRequestById: (userId, sessionId, requestId) =>
      findQuestion(() =>
        questions()
          .where(
            and(
              eq(agentQuestionRequests.id, requestId),
              eq(agentQuestionRequests.sessionId, sessionId),
              eq(agentQuestionRequests.userId, userId),
            ),
          )
          .get(),
      ),
    findSession: (userId, sessionId) => {
      const session = storedActiveSessionState(database, sessionId, userId);
      return session === undefined ? undefined : storedQuestionSession(session);
    },
    insertQuestionRequest: (request) => {
      database
        .insert(agentQuestionRequests)
        .values({
          ...request,
          answeredAt:
            request.answeredAt === null ? null : new Date(request.answeredAt),
          createdAt: new Date(request.createdAt),
          updatedAt: new Date(request.updatedAt),
        })
        .run();
    },
    insertToolResult: (result: QuestionToolResult) => {
      insertStoredMessage(
        database,
        {
          content: result.content,
          images: null,
          role: "tool",
          toolCallId: result.toolCallId,
          toolCalls: null,
          toolName: result.toolName,
        },
        {
          actorId: result.createdById,
          id: result.id,
          now: result.createdAt,
          sessionId: result.sessionId,
          userId: result.userId,
        },
      );
    },
    listRecoverableAnsweredRequests: (runnerId) =>
      database
        .select(QUESTION_SELECTION)
        .from(agentQuestionRequests)
        .innerJoin(
          agentSessions,
          eq(agentSessions.id, agentQuestionRequests.sessionId),
        )
        .where(
          and(
            eq(agentQuestionRequests.isDeleted, false),
            isNotNull(agentQuestionRequests.answeredAt),
            activeSessionCondition({ status: "queued" }),
            runnerSessionCondition(runnerId),
          ),
        )
        .all()
        .map(storedQuestionRequest),
    retireManualCompactionOperations: (sessionId, generation, now) => {
      retireManualCompactionOperations(
        database,
        sessionId,
        generation,
        now,
        "through",
      );
    },
    updateQuestionRequest: (request, update) =>
      exactlyOneUpdatedRow(
        database,
        agentQuestionRequests,
        requestUpdateValues(update),
        and(
          eq(agentQuestionRequests.id, request.id),
          eq(agentQuestionRequests.isDeleted, request.isDeleted),
          nullableDateCondition(
            agentQuestionRequests.answeredAt,
            request.answeredAt,
          ),
          nullableColumnCondition(
            agentQuestionRequests.answers,
            request.answers,
          ),
          eq(agentQuestionRequests.updatedAt, new Date(request.updatedAt)),
        ),
        agentQuestionRequests.id,
      ),
    updateSession: (session, update) =>
      exactlyOneUpdatedRow(
        database,
        agentSessions,
        sessionUpdateValues(update),
        and(
          eq(agentSessions.id, session.id),
          eq(agentSessions.userId, session.userId),
          eq(agentSessions.isDeleted, session.isDeleted),
          eq(agentSessions.status, session.status),
          eq(agentSessions.executionGeneration, session.executionGeneration),
          eq(agentSessions.updatedAt, new Date(session.updatedAt)),
        ),
        agentSessions.id,
      ),
  };
}

export function createAskQuestionsPersistence(
  database: AppDatabase,
): AskQuestionsPersistence {
  return {
    transaction: (action) =>
      database.transaction((transaction) =>
        action(drizzleQuestionTransaction(transaction)),
      ),
  };
}
