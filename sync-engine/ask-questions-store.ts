import {
  canonicalAskQuestionsResult,
  readAskQuestionAnswers,
  readAskQuestionsInput,
  type AskQuestionAnswers,
  type AskQuestionsInput,
  type PendingAskQuestions,
} from "../shared/ask-questions.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import type { SessionStepTiming } from "../shared/session-timing.ts";
import { activeQuestionSession } from "./ask-questions-session.ts";
import type { RecoverableQuestionIdentity } from "./session-lifecycle-types.ts";

export interface StoredQuestionRequest {
  readonly answeredAt: number | null;
  readonly answers: string | null;
  readonly createdAt: number;
  readonly createdById: string;
  readonly executionGeneration: number;
  readonly id: string;
  readonly isDeleted: boolean;
  readonly questions: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly updatedAt: number;
  readonly updatedById: string;
  readonly userId: string;
}

export interface StoredQuestionSession extends SessionStepTiming<number> {
  readonly executionGeneration: number;
  readonly id: string;
  readonly interruptedHandoff: string | null;
  readonly isDeleted: boolean;
  readonly status: AgentSessionStatus;
  readonly updatedAt: number;
  readonly updatedById: string;
  readonly userId: string;
}

export interface QuestionToolResult {
  readonly content: string;
  readonly createdAt: number;
  readonly createdById: string;
  readonly id: string;
  readonly isDeleted: boolean;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: "ask_questions";
  readonly updatedAt: number;
  readonly updatedById: string;
  readonly userId: string;
}

export interface AskQuestionsPersistence {
  transaction<Result>(
    action: (transaction: AskQuestionsPersistenceTransaction) => Result,
  ): Result;
}

export interface AskQuestionsPersistenceTransaction {
  findActiveQuestionRequest(
    userId: string,
    sessionId: string,
  ): StoredQuestionRequest | undefined;
  findQuestionRequest(
    sessionId: string,
    toolCallId: string,
  ): StoredQuestionRequest | undefined;
  findQuestionRequestById(
    userId: string,
    sessionId: string,
    requestId: string,
  ): StoredQuestionRequest | undefined;
  findPendingQuestionRequest(
    userId: string,
    sessionId: string,
  ): StoredQuestionRequest | undefined;
  findSession(
    userId: string,
    sessionId: string,
  ): StoredQuestionSession | undefined;
  insertQuestionRequest(request: StoredQuestionRequest): void;
  insertToolResult(result: QuestionToolResult): void;
  listRecoverableAnsweredRequests(
    runnerId?: string,
  ): readonly StoredQuestionRequest[];
  retireManualCompactionOperations(
    sessionId: string,
    generation: number,
    now: number,
  ): void;
  updateQuestionRequest(
    request: StoredQuestionRequest,
    update: Partial<StoredQuestionRequest>,
  ): boolean;
  updateSession(
    session: StoredQuestionSession,
    update: Partial<StoredQuestionSession>,
  ): boolean;
}

export interface AskQuestionsStoreResources {
  readonly generateId: (now: number) => string;
  readonly persistence: AskQuestionsPersistence;
  readonly systemActorId: string;
}

export type AnswerQuestionRequestResult =
  | {
      readonly request: StoredQuestionRequest;
      readonly result: string;
      readonly status: "already_answered" | "answered";
    }
  | { readonly status: "conflict" | "not_found" | "stale" };

export type CancelQuestionRequestResult =
  | { readonly request: StoredQuestionRequest; readonly status: "cancelled" }
  | { readonly status: "not_found" };

function parseQuestions(value: string): AskQuestionsInput {
  try {
    const parsed: unknown = JSON.parse(value);
    const input = readAskQuestionsInput(parsed);
    if (input !== undefined) {
      return input;
    }
  } catch {
    // The common error below identifies corrupt persisted data.
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
    // The common error below identifies corrupt persisted data.
  }
  throw new Error("Stored agent question answers are invalid");
}

function pendingRequest(stored: StoredQuestionRequest): PendingAskQuestions {
  return {
    ...parseQuestions(stored.questions),
    createdAt: stored.createdAt,
    executionGeneration: stored.executionGeneration,
    id: stored.id,
    toolCallId: stored.toolCallId,
  };
}

function requestIsActive(request: StoredQuestionRequest): boolean {
  return !request.isDeleted;
}

function requestIsAnswered(request: StoredQuestionRequest): boolean {
  return request.answeredAt !== null;
}

function requestIsAnswerable(request: StoredQuestionRequest): boolean {
  return requestIsActive(request) || requestIsAnswered(request);
}

function requestIsPending(request: StoredQuestionRequest): boolean {
  return requestIsActive(request) && request.answeredAt === null;
}

function requestMatches(
  request: StoredQuestionRequest,
  userId: string,
  sessionId: string,
  requestId?: string,
): boolean {
  return (
    request.userId === userId &&
    request.sessionId === sessionId &&
    (requestId === undefined || request.id === requestId)
  );
}

function auditedUpdate(actorId: string, now: number) {
  return { updatedAt: now, updatedById: actorId };
}

function createdRecordAudit(id: string, actorId: string, now: number) {
  return {
    createdAt: now,
    createdById: actorId,
    id,
    isDeleted: false,
    ...auditedUpdate(actorId, now),
  };
}

function activeSessionInState(
  transaction: AskQuestionsPersistenceTransaction,
  userId: string,
  sessionId: string,
  status: AgentSessionStatus,
  executionGeneration?: number,
): StoredQuestionSession | undefined {
  const session = activeQuestionSession(transaction, userId, sessionId);
  return session?.status === status &&
    (executionGeneration === undefined ||
      session.executionGeneration === executionGeneration)
    ? session
    : undefined;
}

function activeDuration(session: StoredQuestionSession, now: number): number {
  return (
    session.activeDurationMs +
    (session.activeStartedAt === null
      ? 0
      : Math.max(0, now - session.activeStartedAt))
  );
}

function updateQuestionSession(
  transaction: AskQuestionsPersistenceTransaction,
  session: StoredQuestionSession,
  status: AgentSessionStatus,
  actorId: string,
  now: number,
  includeDuration: boolean,
): boolean {
  return transaction.updateSession(session, {
    ...(includeDuration
      ? { activeDurationMs: activeDuration(session, now) }
      : {}),
    activeStartedAt: null,
    stepStartedAt: null,
    interruptedHandoff: null,
    status,
    ...auditedUpdate(actorId, now),
  });
}

function transitionAnsweredSession(
  transaction: AskQuestionsPersistenceTransaction,
  session: StoredQuestionSession,
  actorId: string,
  now: number,
): boolean {
  return updateQuestionSession(
    transaction,
    session,
    "queued",
    actorId,
    now,
    false,
  );
}

function answeredClaimTarget(
  transaction: AskQuestionsPersistenceTransaction,
  userId: string,
  sessionId: string,
  requestId: string,
):
  | {
      readonly request: StoredQuestionRequest;
      readonly session: StoredQuestionSession;
    }
  | undefined {
  const request = transaction.findQuestionRequestById(
    userId,
    sessionId,
    requestId,
  );
  const session = activeQuestionSession(transaction, userId, sessionId);
  return request !== undefined &&
    requestMatches(request, userId, sessionId, requestId) &&
    requestIsAnswered(request) &&
    session?.status === "queued" &&
    session.executionGeneration === request.executionGeneration
    ? { request, session }
    : undefined;
}

function updateAnsweredClaim(
  transaction: AskQuestionsPersistenceTransaction,
  userId: string,
  sessionId: string,
  requestId: string,
  isDeleted: boolean,
  actorId: string,
  now: number,
): boolean {
  const target = answeredClaimTarget(transaction, userId, sessionId, requestId);
  return (
    target !== undefined &&
    target.request.isDeleted !== isDeleted &&
    transaction.updateQuestionRequest(target.request, {
      isDeleted,
      ...auditedUpdate(actorId, now),
    })
  );
}

function createdRequest(options: {
  readonly executionGeneration: number;
  readonly id: string;
  readonly input: AskQuestionsInput;
  readonly now: number;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly userId: string;
}): StoredQuestionRequest {
  return {
    answeredAt: null,
    answers: null,
    ...createdRecordAudit(options.id, options.userId, options.now),
    executionGeneration: options.executionGeneration,
    questions: JSON.stringify(options.input),
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    userId: options.userId,
  };
}

type AnsweredClaimParameters = readonly [
  userId: string,
  sessionId: string,
  requestId: string,
  now: number,
];

export class AskQuestionsStore {
  readonly #resources: AskQuestionsStoreResources;

  constructor(resources: AskQuestionsStoreResources) {
    this.#resources = resources;
  }

  create(
    userId: string,
    sessionId: string,
    executionGeneration: number,
    toolCallId: string,
    input: AskQuestionsInput,
    now: number,
  ): PendingAskQuestions {
    return this.#resources.persistence.transaction((transaction) => {
      const previous = transaction.findQuestionRequest(sessionId, toolCallId);
      if (previous !== undefined) {
        if (
          !requestMatches(previous, userId, sessionId) ||
          !requestIsPending(previous) ||
          previous.executionGeneration !== executionGeneration ||
          previous.questions !== JSON.stringify(input)
        ) {
          throw new Error(
            "The ask_questions tool call conflicts with stored state",
          );
        }
        return pendingRequest(previous);
      }

      const active = transaction.findPendingQuestionRequest(userId, sessionId);
      if (active !== undefined && requestIsPending(active)) {
        throw new Error("The agent session already has pending questions");
      }
      const session = activeSessionInState(
        transaction,
        userId,
        sessionId,
        "running",
        executionGeneration,
      );
      if (session?.activeStartedAt === null || session === undefined) {
        throw new Error("The agent session is not running");
      }

      const request = createdRequest({
        executionGeneration,
        id: this.#resources.generateId(now),
        input,
        now,
        sessionId,
        toolCallId,
        userId,
      });
      transaction.insertQuestionRequest(request);
      if (
        !updateQuestionSession(
          transaction,
          session,
          "paused",
          this.#resources.systemActorId,
          now,
          true,
        )
      ) {
        throw new Error("The agent session could not be paused");
      }
      return pendingRequest(request);
    });
  }

  #questionRequest<Value>(
    userId: string,
    sessionId: string,
    requestId: string | undefined,
    read: (stored: StoredQuestionRequest) => Value,
    missing: Value,
  ): Value {
    return this.#resources.persistence.transaction((transaction) => {
      const stored =
        requestId === undefined
          ? transaction.findPendingQuestionRequest(userId, sessionId)
          : transaction.findQuestionRequestById(userId, sessionId, requestId);
      return stored !== undefined &&
        requestMatches(stored, userId, sessionId, requestId) &&
        (requestId === undefined
          ? requestIsPending(stored)
          : requestIsAnswerable(stored))
        ? read(stored)
        : missing;
    });
  }

  pending(userId: string, sessionId: string): PendingAskQuestions | null {
    return this.#questionRequest(
      userId,
      sessionId,
      undefined,
      pendingRequest,
      null,
    );
  }

  input(
    userId: string,
    sessionId: string,
    requestId: string,
  ): AskQuestionsInput | undefined {
    return this.#questionRequest(
      userId,
      sessionId,
      requestId,
      (stored) => parseQuestions(stored.questions),
      undefined,
    );
  }

  answer(
    userId: string,
    sessionId: string,
    requestId: string,
    submittedAnswers: AskQuestionAnswers,
    now: number,
  ): AnswerQuestionRequestResult {
    return this.#resources.persistence.transaction((transaction) => {
      const stored = transaction.findQuestionRequestById(
        userId,
        sessionId,
        requestId,
      );
      if (
        stored === undefined ||
        !requestMatches(stored, userId, sessionId, requestId) ||
        !requestIsAnswerable(stored)
      ) {
        return { status: "not_found" as const };
      }
      const input = parseQuestions(stored.questions);
      const answers = readAskQuestionAnswers(submittedAnswers, input.questions);
      if (answers === undefined) {
        throw new Error("The question answers are invalid");
      }
      const result = canonicalAskQuestionsResult(answers);
      if (requestIsAnswered(stored)) {
        if (stored.answers === null) {
          throw new Error("Stored agent question answers are missing");
        }
        const previous = parseAnswers(stored.answers, input.questions);
        return canonicalAskQuestionsResult(previous) === result
          ? { request: stored, result, status: "already_answered" as const }
          : { status: "conflict" as const };
      }
      if (!requestIsPending(stored)) {
        return { status: "not_found" as const };
      }
      const session = activeSessionInState(
        transaction,
        userId,
        sessionId,
        "paused",
        stored.executionGeneration,
      );
      if (session === undefined) {
        return { status: "stale" as const };
      }

      const updatedRequest: StoredQuestionRequest = {
        ...stored,
        answeredAt: now,
        answers: JSON.stringify(answers),
        ...auditedUpdate(userId, now),
      };
      if (!transaction.updateQuestionRequest(stored, updatedRequest)) {
        throw new Error("The question request changed while being answered");
      }
      transaction.insertToolResult({
        content: result,
        ...createdRecordAudit(this.#resources.generateId(now), userId, now),
        sessionId,
        toolCallId: stored.toolCallId,
        toolName: "ask_questions",
        userId,
      });
      if (!transitionAnsweredSession(transaction, session, userId, now)) {
        throw new Error("The answered agent session could not be queued");
      }
      return { request: updatedRequest, result, status: "answered" as const };
    });
  }

  #setAnsweredClaim(
    ...[userId, sessionId, requestId, now, claimed]: readonly [
      ...AnsweredClaimParameters,
      claimed: boolean,
    ]
  ): boolean {
    return this.#resources.persistence.transaction((transaction) =>
      updateAnsweredClaim(
        transaction,
        userId,
        sessionId,
        requestId,
        claimed,
        this.#resources.systemActorId,
        now,
      ),
    );
  }

  claimAnswered = (...parameters: AnsweredClaimParameters): boolean =>
    this.#setAnsweredClaim(...parameters, true);

  releaseAnsweredClaim = (...parameters: AnsweredClaimParameters): boolean =>
    this.#setAnsweredClaim(...parameters, false);

  cancel(
    userId: string,
    sessionId: string,
    now: number,
  ): CancelQuestionRequestResult {
    return this.#resources.persistence.transaction((transaction) => {
      const request = transaction.findPendingQuestionRequest(userId, sessionId);
      if (
        request === undefined ||
        !requestMatches(request, userId, sessionId) ||
        !requestIsPending(request)
      ) {
        return { status: "not_found" as const };
      }
      const cancelled: StoredQuestionRequest = {
        ...request,
        isDeleted: true,
        ...auditedUpdate(userId, now),
      };
      return transaction.updateQuestionRequest(request, cancelled)
        ? { request: cancelled, status: "cancelled" as const }
        : { status: "not_found" as const };
    });
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    return this.#resources.persistence.transaction((transaction) => {
      const session = activeQuestionSession(transaction, userId, sessionId);
      if (session === undefined) {
        return false;
      }
      const request = transaction.findActiveQuestionRequest(userId, sessionId);
      if (
        request !== undefined &&
        requestMatches(request, userId, sessionId) &&
        requestIsActive(request) &&
        !transaction.updateQuestionRequest(request, {
          isDeleted: true,
          ...auditedUpdate(userId, now),
        })
      ) {
        throw new Error("The pending question request could not be cancelled");
      }

      if (
        !updateQuestionSession(
          transaction,
          session,
          "stopped",
          userId,
          now,
          true,
        )
      ) {
        return false;
      }
      transaction.retireManualCompactionOperations(
        sessionId,
        session.executionGeneration,
        now,
      );
      return true;
    });
  }

  recoverable(runnerId?: string): readonly RecoverableQuestionIdentity[] {
    return this.#resources.persistence.transaction((transaction) =>
      transaction
        .listRecoverableAnsweredRequests(runnerId)
        .filter(
          (request) => requestIsActive(request) && requestIsAnswered(request),
        )
        .map((request) => ({
          executionGeneration: request.executionGeneration,
          requestId: request.id,
          sessionId: request.sessionId,
          userId: request.userId,
        })),
    );
  }
}
