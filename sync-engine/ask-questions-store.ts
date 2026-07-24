/* jscpd:ignore-start */
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  canonicalAskQuestionsResult,
  readAskQuestionAnswers,
  readAskQuestionsInput,
  type AskQuestionAnswers,
  type AskQuestionsInput,
  type PendingAskQuestions,
} from "../shared/ask-questions.ts";
import {
  createdAuditFields,
  softDeletedAuditFields,
  updatedAuditFields,
} from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentMessages,
  agentQuestionRequests,
  agentSessions,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";

export interface AskQuestionsStoreResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}
type StoredQuestionRequest = typeof agentQuestionRequests.$inferSelect;

type AnswerQuestionRequestResult =
  | {
      readonly result: string;
      readonly status: "already_answered" | "answered";
    }
  | "conflict"
  | "not_found";

function parseQuestions(value: string): AskQuestionsInput {
  try {
    const parsed: unknown = JSON.parse(value);
    const input = readAskQuestionsInput(parsed);
    if (input !== undefined) {
      return input;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent questions are invalid");
}

function parseAnswers(
  value: string,
  questions: AskQuestionsInput["questions"],
): AskQuestionAnswers {
  try {
    const parsed: unknown = JSON.parse(value);
    const answers = readAskQuestionAnswers(parsed, questions);
    if (answers !== undefined) {
      return answers;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent question answers are invalid");
}

function pendingRequest(stored: StoredQuestionRequest): PendingAskQuestions {
  return {
    ...parseQuestions(stored.questions),
    createdAt: stored.createdAt.getTime(),
    id: stored.id,
    toolCallId: stored.toolCallId,
  };
}

function requestCondition(
  userId: string,
  sessionId: string,
  requestId?: string,
) {
  return and(
    eq(agentQuestionRequests.userId, userId),
    eq(agentQuestionRequests.sessionId, sessionId),
    requestId === undefined
      ? undefined
      : eq(agentQuestionRequests.id, requestId),
  );
}

function activeRequestCondition(
  userId: string,
  sessionId: string,
  requestId?: string,
) {
  return and(
    requestCondition(userId, sessionId, requestId),
    eq(agentQuestionRequests.isDeleted, false),
  );
}

function answerableRequestCondition(
  userId: string,
  sessionId: string,
  requestId: string,
) {
  return and(
    requestCondition(userId, sessionId, requestId),
    or(
      eq(agentQuestionRequests.isDeleted, false),
      isNotNull(agentQuestionRequests.answeredAt),
    ),
  );
}

export class AskQuestionsStore {
  readonly #resources: AskQuestionsStoreResources;

  constructor(resources: AskQuestionsStoreResources) {
    this.#resources = resources;
  }

  create(
    userId: string,
    sessionId: string,
    toolCallId: string,
    input: AskQuestionsInput,
    now: number,
  ): PendingAskQuestions {
    return this.#resources.database.transaction((transaction) => {
      const previous = transaction
        .select()
        .from(agentQuestionRequests)
        .where(
          and(
            eq(agentQuestionRequests.sessionId, sessionId),
            eq(agentQuestionRequests.toolCallId, toolCallId),
          ),
        )
        .get();
      if (previous !== undefined) {
        if (
          previous.userId !== userId ||
          previous.isDeleted ||
          previous.answeredAt !== null ||
          previous.questions !== JSON.stringify(input)
        ) {
          throw new Error(
            "The ask_questions tool call conflicts with stored state",
          );
        }
        return pendingRequest(previous);
      }

      const session = transaction
        .select({
          activeDurationMs: agentSessions.activeDurationMs,
          activeStartedAt: agentSessions.activeStartedAt,
          id: agentSessions.id,
        })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.userId, userId),
            eq(agentSessions.isDeleted, false),
            eq(agentSessions.status, "running"),
          ),
        )
        .get();
      if (session?.activeStartedAt == null) {
        throw new Error("The agent session is not running");
      }

      const id = this.#resources.generateId(now);
      transaction
        .insert(agentQuestionRequests)
        .values({
          ...createdAuditFields(userId, now),
          id,
          questions: JSON.stringify(input),
          sessionId,
          toolCallId,
          userId,
        })
        .run();
      transaction
        .update(agentSessions)
        .set({
          activeDurationMs: activeSessionDuration(session, now),
          activeStartedAt: null,
          status: "waiting",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.status, "running"),
          ),
        )
        .run();
      const created = transaction
        .select()
        .from(agentQuestionRequests)
        .where(eq(agentQuestionRequests.id, id))
        .get();
      if (created === undefined) {
        throw new Error(
          "The question request could not be read after creation",
        );
      }
      return pendingRequest(created);
    });
  }

  pending(userId: string, sessionId: string): PendingAskQuestions | null {
    const stored = this.#resources.database
      .select()
      .from(agentQuestionRequests)
      .where(
        and(
          activeRequestCondition(userId, sessionId),
          isNull(agentQuestionRequests.answeredAt),
        ),
      )
      .get();
    return stored === undefined ? null : pendingRequest(stored);
  }

  input(
    userId: string,
    sessionId: string,
    requestId: string,
  ): AskQuestionsInput | undefined {
    const stored = this.#resources.database
      .select({ questions: agentQuestionRequests.questions })
      .from(agentQuestionRequests)
      .where(answerableRequestCondition(userId, sessionId, requestId))
      .get();
    return stored === undefined ? undefined : parseQuestions(stored.questions);
  }

  answer(
    userId: string,
    sessionId: string,
    requestId: string,
    submittedAnswers: AskQuestionAnswers,
    now: number,
  ): AnswerQuestionRequestResult {
    return this.#resources.database.transaction((transaction) => {
      const stored = transaction
        .select()
        .from(agentQuestionRequests)
        .where(answerableRequestCondition(userId, sessionId, requestId))
        .get();
      if (stored === undefined) {
        return "not_found" as const;
      }
      const input = parseQuestions(stored.questions);
      const answers = readAskQuestionAnswers(submittedAnswers, input.questions);
      if (answers === undefined) {
        throw new Error("The question answers are invalid");
      }
      const result = canonicalAskQuestionsResult(answers);
      if (stored.answeredAt !== null) {
        if (stored.answers === null) {
          throw new Error("Stored agent question answers are missing");
        }
        const previous = parseAnswers(stored.answers, input.questions);
        return canonicalAskQuestionsResult(previous) === result
          ? { result, status: "already_answered" as const }
          : ("conflict" as const);
      }
      const session = transaction
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.userId, userId),
            eq(agentSessions.isDeleted, false),
            eq(agentSessions.status, "waiting"),
          ),
        )
        .get();
      if (session === undefined) {
        return "not_found" as const;
      }

      transaction
        .update(agentQuestionRequests)
        .set({
          answers: JSON.stringify(answers),
          answeredAt: new Date(now),
          ...updatedAuditFields(userId, now),
        })
        .where(
          and(
            eq(agentQuestionRequests.id, requestId),
            isNull(agentQuestionRequests.answeredAt),
          ),
        )
        .run();
      transaction
        .insert(agentMessages)
        .values({
          ...createdAuditFields(userId, now),
          content: result,
          id: this.#resources.generateId(now),
          role: "tool",
          sessionId,
          toolCallId: stored.toolCallId,
          toolName: "ask_questions",
          userId,
        })
        .run();
      transaction
        .update(agentSessions)
        .set({
          activeStartedAt: null,
          status: "queued",
          ...updatedAuditFields(userId, now),
        })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.status, "waiting"),
          ),
        )
        .run();
      return { result, status: "answered" as const };
    });
  }

  startAnsweredSession(
    userId: string,
    sessionId: string,
    now: number,
  ): boolean | undefined {
    return this.#resources.database.transaction((transaction) => {
      const request = transaction
        .select({ id: agentQuestionRequests.id })
        .from(agentQuestionRequests)
        .where(
          and(
            activeRequestCondition(userId, sessionId),
            isNotNull(agentQuestionRequests.answeredAt),
          ),
        )
        .get();
      if (request === undefined) {
        return undefined;
      }

      const started = transaction
        .update(agentSessions)
        .set({
          activeStartedAt: new Date(now),
          status: "running",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.userId, userId),
            eq(agentSessions.isDeleted, false),
            eq(agentSessions.status, "queued"),
          ),
        )
        .returning({ id: agentSessions.id })
        .all();
      if (started.length === 0) {
        return false;
      }

      return (
        transaction
          .update(agentQuestionRequests)
          .set(softDeletedAuditFields(SYSTEM_ID, now))
          .where(
            and(
              eq(agentQuestionRequests.id, request.id),
              eq(agentQuestionRequests.isDeleted, false),
              isNotNull(agentQuestionRequests.answeredAt),
            ),
          )
          .returning({ id: agentQuestionRequests.id })
          .all().length > 0
      );
    });
  }

  cancel(userId: string, sessionId: string, now: number): boolean {
    return (
      this.#resources.database
        .update(agentQuestionRequests)
        .set(softDeletedAuditFields(userId, now))
        .where(activeRequestCondition(userId, sessionId))
        .returning({ id: agentQuestionRequests.id })
        .all().length > 0
    );
  }

  recoverable(): readonly { readonly id: string; readonly userId: string }[] {
    return this.#resources.database
      .selectDistinct({ id: agentSessions.id, userId: agentSessions.userId })
      .from(agentSessions)
      .innerJoin(
        agentQuestionRequests,
        and(
          eq(agentQuestionRequests.sessionId, agentSessions.id),
          eq(agentQuestionRequests.isDeleted, false),
          isNotNull(agentQuestionRequests.answeredAt),
        ),
      )
      .where(
        and(
          eq(agentSessions.isDeleted, false),
          eq(agentSessions.status, "queued"),
          eq(agentQuestionRequests.isDeleted, false),
          isNotNull(agentQuestionRequests.answeredAt),
        ),
      )
      .all();
  }
}
/* jscpd:ignore-end */
