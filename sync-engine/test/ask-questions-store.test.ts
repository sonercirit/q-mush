import { describe, expect, test } from "vitest";
import type { AskQuestionAnswers } from "../../shared/ask-questions.ts";
import {
  AskQuestionsStore,
  type AskQuestionsPersistence,
  type AskQuestionsPersistenceTransaction,
  type QuestionToolResult,
  type StoredQuestionRequest,
  type StoredQuestionSession,
} from "../../sync-engine/ask-questions-store.ts";
import {
  TEST_QUESTION_ANSWERS,
  testAskQuestionsInput,
} from "./ask-questions-test-fixtures.ts";

interface MemoryQuestionState {
  readonly requests: StoredQuestionRequest[];
  readonly sessions: StoredQuestionSession[];
  readonly toolResults: QuestionToolResult[];
}

function cloneState(state: MemoryQuestionState): MemoryQuestionState {
  return structuredClone(state);
}

function replaceState(
  target: MemoryQuestionState,
  source: MemoryQuestionState,
): void {
  target.requests.splice(0, target.requests.length, ...source.requests);
  target.sessions.splice(0, target.sessions.length, ...source.sessions);
  target.toolResults.splice(
    0,
    target.toolResults.length,
    ...source.toolResults,
  );
}

function replaceMatching<Value>(
  values: Value[],
  expected: Value,
  update: Partial<Value>,
): boolean {
  const index = values.indexOf(expected);
  if (index < 0) {
    return false;
  }
  values[index] = { ...expected, ...update };
  return true;
}

class MemoryAskQuestionsPersistence implements AskQuestionsPersistence {
  readonly state: MemoryQuestionState;
  #busy = false;

  constructor(sessions: readonly StoredQuestionSession[] = []) {
    this.state = { requests: [], sessions: [...sessions], toolResults: [] };
  }

  transaction<Result>(
    action: (transaction: AskQuestionsPersistenceTransaction) => Result,
  ): Result {
    if (this.#busy) {
      throw new Error("Nested memory question transactions are unsupported");
    }
    this.#busy = true;
    const draft = cloneState(this.state);
    try {
      const result = action(transactionFor(draft));
      replaceState(this.state, draft);
      return result;
    } finally {
      this.#busy = false;
    }
  }
}

function activeRequest(
  state: MemoryQuestionState,
  userId: string,
  sessionId: string,
) {
  return state.requests.find(
    (request) =>
      request.userId === userId &&
      request.sessionId === sessionId &&
      !request.isDeleted,
  );
}

function transactionFor(
  state: MemoryQuestionState,
): AskQuestionsPersistenceTransaction {
  return {
    findActiveQuestionRequest: (userId, sessionId) =>
      activeRequest(state, userId, sessionId),
    findPendingQuestionRequest: (userId, sessionId) => {
      const request = activeRequest(state, userId, sessionId);
      return request?.answeredAt === null ? request : undefined;
    },
    findQuestionRequest: (sessionId, toolCallId) =>
      state.requests.find(
        (request) =>
          request.sessionId === sessionId && request.toolCallId === toolCallId,
      ),
    findQuestionRequestById: (userId, sessionId, requestId) =>
      state.requests.find(
        (request) =>
          request.id === requestId &&
          request.sessionId === sessionId &&
          request.userId === userId,
      ),
    findSession: (userId, sessionId) =>
      state.sessions.find(
        (session) => session.id === sessionId && session.userId === userId,
      ),
    insertQuestionRequest: (request) => {
      if (
        state.requests.some(
          (stored) =>
            stored.sessionId === request.sessionId &&
            (stored.toolCallId === request.toolCallId ||
              (!stored.isDeleted && stored.answeredAt === null)),
        )
      ) {
        throw new Error("Question request uniqueness violation");
      }
      state.requests.push(request);
    },
    insertToolResult: (result) => {
      if (
        state.toolResults.some(
          (stored) =>
            stored.sessionId === result.sessionId &&
            stored.toolCallId === result.toolCallId &&
            !stored.isDeleted,
        )
      ) {
        throw new Error("Duplicate tool result");
      }
      state.toolResults.push(result);
    },
    listRecoverableAnsweredRequests: () =>
      state.requests.filter((request) => {
        const session = state.sessions.find(
          (candidate) =>
            candidate.id === request.sessionId &&
            candidate.userId === request.userId,
        );
        return session?.status === "queued";
      }),
    retireManualCompactionOperations: () => undefined,
    updateQuestionRequest: (request, update) =>
      replaceMatching(state.requests, request, update),
    updateSession: (session, update) =>
      replaceMatching(state.sessions, session, update),
  };
}

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const REQUEST_ID = "request-1";
const MESSAGE_ID = "message-1";
const NOW = 1_000;

const validInput = testAskQuestionsInput();
const input = validInput;
const answers: AskQuestionAnswers = TEST_QUESTION_ANSWERS;

function runningSession(): StoredQuestionSession {
  return {
    activeDurationMs: 20,
    activeStartedAt: NOW,
    executionGeneration: 3,
    id: SESSION_ID,
    interruptedHandoff: "durable-shutdown-marker",
    isDeleted: false,
    status: "running",
    updatedAt: NOW,
    updatedById: "SYSTEM",
    userId: USER_ID,
  };
}

function setup() {
  const persistence = new MemoryAskQuestionsPersistence([runningSession()]);
  const ids = [REQUEST_ID, MESSAGE_ID];
  const store = new AskQuestionsStore({
    generateId: () => ids.shift() ?? "unexpected-id",
    persistence,
    systemActorId: "SYSTEM",
  });
  return { persistence, store };
}

function setupWithQuestion() {
  const configured = setup();
  configured.store.create(
    USER_ID,
    SESSION_ID,
    3,
    "call-question",
    validInput,
    NOW + 20,
  );
  return configured;
}

function pendingQuestionStatus(store: AskQuestionsStore) {
  return store.pending(USER_ID, SESSION_ID);
}

function currentRequest(persistence: MemoryAskQuestionsPersistence) {
  return persistence.state.requests[0];
}

function expectCurrentRequest(
  persistence: MemoryAskQuestionsPersistence,
  expected: Partial<StoredQuestionRequest>,
): void {
  expect(currentRequest(persistence)).toMatchObject(expected);
}

function expectSessionStatus(
  persistence: MemoryAskQuestionsPersistence,
  status: StoredQuestionSession["status"],
): void {
  expect(persistence.state.sessions[0]?.status).toBe(status);
}

function expectRecoverableRequest(
  store: AskQuestionsStore,
  expected: readonly unknown[],
): void {
  expect(store.recoverable()).toEqual(expected);
}

function answerQuestion(
  store: AskQuestionsStore,
  now = NOW + 30,
  selectedAnswers = answers,
) {
  return store.answer(USER_ID, SESSION_ID, REQUEST_ID, selectedAnswers, now);
}

function answeredQuestion() {
  const configured = setupWithQuestion();
  answerQuestion(configured.store);
  return configured;
}

describe("ask questions store", () => {
  test("persists one audited pending call and returns it idempotently", () => {
    const { persistence, store } = setup();
    const created = store.create(
      USER_ID,
      SESSION_ID,
      3,
      "call-question",
      input,
      NOW + 20,
    );
    const repeated = store.create(
      USER_ID,
      SESSION_ID,
      3,
      "call-question",
      input,
      NOW + 30,
    );

    expect(repeated).toEqual(created);
    expect(store.pending(USER_ID, SESSION_ID)).toEqual(created);
    expect(store.input(USER_ID, SESSION_ID, REQUEST_ID)).toEqual(input);
    expect(persistence.state.sessions[0]).toMatchObject({
      activeDurationMs: 40,
      activeStartedAt: null,
      interruptedHandoff: null,
      status: "paused",
    });
    expect(persistence.state.requests[0]).toMatchObject({
      createdById: USER_ID,
      executionGeneration: 3,
      id: REQUEST_ID,
      isDeleted: false,
    });
  });

  test("rejects a second active request and rolls creation back", () => {
    const { persistence, store } = setupWithQuestion();
    persistence.state.sessions[0] = {
      ...runningSession(),
      activeStartedAt: NOW + 21,
    };

    expect(() =>
      store.create(USER_ID, SESSION_ID, 3, "call-other", input, NOW + 30),
    ).toThrow("already has pending questions");
    expect(persistence.state.requests).toHaveLength(1);
  });

  test("does not persist a request when the generation is stale", () => {
    const { persistence, store } = setup();
    expect(() =>
      store.create(USER_ID, SESSION_ID, 2, "call-question", input, NOW + 20),
    ).toThrow("not running");
    expect(persistence.state.requests).toEqual([]);
  });

  test("answers atomically and only for the owner", () => {
    const { persistence, store } = setupWithQuestion();

    expect(
      store.answer("forged-user", SESSION_ID, REQUEST_ID, answers, NOW + 30),
    ).toEqual({ status: "not_found" });
    expect(
      store.answer(USER_ID, SESSION_ID, REQUEST_ID, answers, NOW + 40),
    ).toMatchObject({ status: "answered" });
    expect(pendingQuestionStatus(store)).toBeNull();
    expect(persistence.state.toolResults).toHaveLength(1);
    expect(persistence.state.toolResults[0]).toMatchObject({
      toolCallId: "call-question",
      toolName: "ask_questions",
    });
    expectSessionStatus(persistence, "queued");
  });

  test("keeps a successfully launched answer claimed", () => {
    const { persistence, store } = answeredQuestion();

    expect(store.claimAnswered(USER_ID, SESSION_ID, REQUEST_ID, NOW + 40)).toBe(
      true,
    );
    expectCurrentRequest(persistence, {
      answeredAt: NOW + 30,
      isDeleted: true,
      updatedById: "SYSTEM",
    });
    expectRecoverableRequest(store, []);
  });

  test("reactivates an answered claim when resumed launch is refused", () => {
    const { persistence, store } = answeredQuestion();
    store.claimAnswered(USER_ID, SESSION_ID, REQUEST_ID, NOW + 40);

    expect(
      store.releaseAnsweredClaim(USER_ID, SESSION_ID, REQUEST_ID, NOW + 50),
    ).toBe(true);

    expectCurrentRequest(persistence, {
      answeredAt: NOW + 30,
      isDeleted: false,
      updatedById: "SYSTEM",
    });

    expectRecoverableRequest(store, [
      {
        executionGeneration: 3,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        userId: USER_ID,
      },
    ]);
  });

  test("serializes duplicate answers without duplicate tool output", async () => {
    const { persistence, store } = setupWithQuestion();

    const attempts = await Promise.all([
      Promise.resolve().then(() => answerQuestion(store)),
      Promise.resolve().then(() => answerQuestion(store, NOW + 40)),
    ]);

    expect(attempts.map(({ status }) => status).sort()).toEqual([
      "already_answered",
      "answered",
    ]);
    expect(persistence.state.toolResults).toHaveLength(1);
    expect(
      answerQuestion(store, NOW + 50, {
        answers: [{ questionId: "decision", value: "stop" }],
      }),
    ).toEqual({ status: "conflict" });
  });

  test("delivers a custom answer in the tool result", () => {
    const { persistence, store } = setupWithQuestion();

    expect(
      answerQuestion(store, NOW + 30, {
        answers: [{ questionId: "decision", value: "wait for approval" }],
      }),
    ).toMatchObject({ status: "answered" });
    expect(persistence.state.toolResults[0]?.content).toContain(
      '"value": "wait for approval"',
    );
  });

  test("rejects invalid answers without changing pending state", () => {
    const { persistence, store } = setupWithQuestion();

    expect(() =>
      answerQuestion(store, NOW + 30, {
        answers: [{ questionId: "decision", value: "   " }],
      }),
    ).toThrow("invalid");
    expect(pendingQuestionStatus(store)).not.toBeNull();
    expect(persistence.state.toolResults).toEqual([]);
    expectSessionStatus(persistence, "paused");
  });

  test("atomically stops and soft-cancels pending questions", () => {
    const { persistence, store } = setupWithQuestion();
    const pausedSession = persistence.state.sessions[0];
    if (pausedSession === undefined) {
      throw new Error("The paused test session is unavailable");
    }
    persistence.state.sessions[0] = {
      ...pausedSession,
      interruptedHandoff: "durable-shutdown-marker",
    };
    expect(pendingQuestionStatus(store)).not.toBeNull();

    expect(store.stop(USER_ID, SESSION_ID, NOW + 30)).toBe(true);
    expect(pendingQuestionStatus(store)).toBeNull();
    expectCurrentRequest(persistence, {
      isDeleted: true,
      updatedById: USER_ID,
    });

    expectSessionStatus(persistence, "stopped");
    expect(persistence.state.sessions[0].interruptedHandoff).toBeNull();
  });
});
