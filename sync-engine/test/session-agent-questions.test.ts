import { describe, expect, test, vi } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import {
  isAskQuestionsPause,
  pauseForAskQuestions,
} from "../../sync-engine/ask-questions-pause.ts";
import type {
  AskQuestionsStore,
  StoredQuestionRequest,
} from "../../sync-engine/ask-questions-store.ts";
import {
  answerSessionQuestionsCommand,
  isQuestionActionFailure,
} from "../../sync-engine/session-question-actions.ts";
import {
  TEST_QUESTION_ANSWERS,
  testAskQuestionsInput,
} from "./ask-questions-test-fixtures.ts";

type AnswerQuestionRequestResult = ReturnType<AskQuestionsStore["answer"]>;

const USER: AuthenticatedUser = {
  email: "user@example.test",
  id: "user-1",
  name: "User",
};

const INPUT = testAskQuestionsInput();
const ANSWERS = TEST_QUESTION_ANSWERS;
const REQUEST: StoredQuestionRequest = {
  answeredAt: null,
  answers: null,
  createdAt: 1,
  createdById: USER.id,
  executionGeneration: 7,
  id: "request-1",
  isDeleted: false,
  questions: JSON.stringify(INPUT),
  sessionId: "session-1",
  toolCallId: "call-1",
  updatedAt: 1,
  updatedById: USER.id,
  userId: USER.id,
};

const ANSWER_COMMAND_INPUT = {
  ...ANSWERS,
  requestId: REQUEST.id,
  sessionId: REQUEST.sessionId,
};

function actionSetup(result: AnswerQuestionRequestResult) {
  const answer = vi.fn(() => result);
  const input = vi.fn((userId: string) =>
    userId === USER.id ? INPUT : undefined,
  );
  const callbacks = [vi.fn(() => true), vi.fn()] as const;
  const [launch, notify] = callbacks;
  return {
    answer,
    dependencies: {
      launchAnswered: launch,
      notify,
      now: () => 2,
      questions: {
        answer,
        claimAnswered: vi.fn(() => true),
        input,
        recoverable: vi.fn(() => []),
        releaseAnsweredClaim: vi.fn(() => true),
      } satisfies Pick<
        AskQuestionsStore,
        | "answer"
        | "claimAnswered"
        | "input"
        | "recoverable"
        | "releaseAnsweredClaim"
      >,
    },
    launchAnswered: launch,
    notify,
  };
}

describe("ask_questions agent tool", () => {
  test("pauses only a selected direct invocation", () => {
    const create = vi.fn(() => ({
      ...INPUT,
      createdAt: 1,
      executionGeneration: 7,
      id: "request-1",
      toolCallId: "call-1",
    }));
    const notify = vi.fn();
    const dependencies = {
      now: () => 1,
      notify,
      questions: { create },
    };
    const invocation = {
      arguments: { questions: INPUT.questions },
      executionGeneration: 7,
      selected: true,
      sessionId: "session-1",
      source: "direct" as const,
      toolCallId: "call-1",
      userId: USER.id,
    };

    let pause: unknown;
    try {
      pauseForAskQuestions(dependencies, invocation);
    } catch (error) {
      pause = error;
    }
    expect(isAskQuestionsPause(pause)).toBe(true);
    expect(pause).toEqual(expect.objectContaining({ requestId: "request-1" }));
    expect(create).toHaveBeenCalledWith(
      USER.id,
      "session-1",
      7,
      "call-1",
      INPUT,
      1,
    );
    expect(notify).toHaveBeenCalledWith(USER.id, "session-1");

    expect(
      pauseForAskQuestions(dependencies, { ...invocation, selected: false }),
    ).toContain("not enabled");
    expect(
      pauseForAskQuestions(dependencies, {
        ...invocation,
        source: "nested",
      }),
    ).toContain("cannot run inside");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("answers through the authenticated realtime action", async () => {
    const answered = actionSetup({
      request: { ...REQUEST, answeredAt: 2 },
      result: "canonical result",
      status: "answered",
    });
    const result = await answerSessionQuestionsCommand(
      answered.dependencies,
      USER,
      ANSWER_COMMAND_INPUT,
    );

    expect(result).toEqual({
      launchStarted: true,
      result: "canonical result",
      status: "answered",
    });
    expect(answered.answer).toHaveBeenCalledWith(
      USER.id,
      REQUEST.sessionId,
      REQUEST.id,
      ANSWERS,
      2,
    );
    expect(answered.notify).toHaveBeenCalledWith(USER.id, REQUEST.sessionId);
    expect(answered.launchAnswered).toHaveBeenCalledWith({
      executionGeneration: 7,
      requestId: REQUEST.id,
      sessionId: REQUEST.sessionId,
      userId: USER.id,
    });
  });

  test("rejects forged ownership and malformed nested payloads", async () => {
    const setup = actionSetup({ status: "not_found" });
    await expect(
      answerSessionQuestionsCommand(
        setup.dependencies,
        { ...USER, id: "forged-user" },
        ANSWER_COMMAND_INPUT,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      answerSessionQuestionsCommand(setup.dependencies, USER, {
        ...ANSWERS,
        nested: { operation: "sessions.answer_questions" },
        requestId: REQUEST.id,
        sessionId: REQUEST.sessionId,
      }),
    ).rejects.toSatisfy(isQuestionActionFailure);
  });
});
