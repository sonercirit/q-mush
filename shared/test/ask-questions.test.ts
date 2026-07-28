import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ANSWER_QUESTIONS_REALTIME_OPERATION,
  canonicalAskQuestionsResult,
  readAnswerQuestionsRealtimePayload,
  readAskQuestionAnswers,
  readAskQuestionsInput,
  readPendingAskQuestions,
} from "../../shared/ask-questions.ts";

const MIXED_CHECK_OPTIONS = [
  { label: "Tests", value: "tests" },
  { label: "Types", value: "types" },
  { label: "Lint", value: "lint" },
];

const MIXED_QUESTIONS = {
  questions: [
    {
      id: "summary",
      maxLength: 120,
      minLength: 3,
      prompt: "What should the summary say?",
      type: "free_text",
    },
    {
      id: "format",
      options: [
        { label: "Markdown", value: "markdown" },
        { label: "Plain text", value: "plain" },
      ],
      prompt: "Choose an output format",
      type: "single_choice",
    },
    {
      id: "checks",
      maxSelections: 2,
      minSelections: 1,
      options: MIXED_CHECK_OPTIONS,
      prompt: "Which checks should run?",
      type: "multi_choice",
    },
  ],
};

function invalidQuestionInput(
  question: Readonly<Record<string, unknown>>,
): void {
  expect(readAskQuestionsInput({ questions: [question] })).toBeUndefined();
}

function answerInput(checks: unknown, format = "markdown") {
  return {
    answers: [
      { questionId: "summary", value: "long enough" },
      { questionId: "format", value: format },
      { questionId: "checks", value: checks },
    ],
  };
}

function realtimeAnswerPayload(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return Object.assign(
    {
      answers: [{ questionId: "summary", value: "Ship it" }],
      requestId: "request-1",
      sessionId: "session-1",
    },
    overrides,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ask_questions parsing", () => {
  test("reads bounded mixed questions and canonicalizes answers", () => {
    const input = readAskQuestionsInput(MIXED_QUESTIONS);
    expect(input).toEqual(MIXED_QUESTIONS);
    expect(input).toBeDefined();

    const answers = readAskQuestionAnswers(
      {
        answers: [
          { questionId: "checks", value: ["types", "tests"] },
          { questionId: "summary", value: "  Ship it  " },
          { questionId: "format", value: "markdown" },
        ],
      },
      input?.questions ?? [],
    );

    expect(answers).toEqual({
      answers: [
        { questionId: "summary", value: "Ship it" },
        { questionId: "format", value: "markdown" },
        { questionId: "checks", value: ["types", "tests"] },
      ],
    });
    if (answers === undefined) {
      throw new Error("The test answers were invalid");
    }
    expect(canonicalAskQuestionsResult(answers)).toContain(
      '"questionId": "summary"',
    );
  });

  test("enforces request and option bounds", () => {
    invalidQuestionInput({
      id: "text",
      prompt: "Unbounded",
      type: "free_text",
    });
    expect(
      readAskQuestionsInput({
        questions: Array.from({ length: 9 }, (_, index) => ({
          id: `text-${String(index)}`,
          maxLength: 10,
          prompt: "Too many questions",
          type: "free_text",
        })),
      }),
    ).toBeUndefined();
    invalidQuestionInput({
      id: "too-many-options",
      options: Array.from({ length: 13 }, (_, index) => ({
        label: `Option ${String(index)}`,
        value: `option-${String(index)}`,
      })),
      prompt: "Too many options",
      type: "single_choice",
    });

    invalidQuestionInput({
      id: "many",
      maxSelections: 1,
      minSelections: 2,
      options: [
        { label: "One", value: "one" },
        { label: "Two", value: "two" },
      ],
      prompt: "Impossible bounds",
      type: "multi_choice",
    });
  });

  test("rejects duplicate identities, unknown fields, and duplicate options", () => {
    invalidQuestionInput({
      id: "text",
      maxLength: 10,
      prompt: "Unexpected field",
      type: "free_text",
      unexpected: true,
    });

    invalidQuestionInput({
      id: "choice",
      options: [
        { label: "One", value: "same" },
        { label: "Two", value: "same" },
      ],
      prompt: "Duplicate values",
      type: "single_choice",
    });

    expect(
      readAskQuestionsInput({
        questions: [
          { id: "same", maxLength: 5, prompt: "First", type: "free_text" },
          { id: "same", maxLength: 5, prompt: "Second", type: "free_text" },
        ],
      }),
    ).toBeUndefined();
  });

  test("accepts custom text answers for either choice kind", () => {
    const questions = readAskQuestionsInput(MIXED_QUESTIONS)?.questions ?? [];
    expect(
      readAskQuestionAnswers(
        answerInput("  run security scan  ", "  surprise me  "),
        questions,
      ),
    ).toEqual(answerInput("run security scan", "surprise me"));
    expect(
      readAskQuestionAnswers(answerInput("   "), questions),
    ).toBeUndefined();
    expect(readAskQuestionAnswers(answerInput(42), questions)).toBeUndefined();
  });

  test("requires exactly one valid answer for every question", () => {
    const questions = readAskQuestionsInput(MIXED_QUESTIONS)?.questions ?? [];
    for (const invalid of [
      { answers: [] },
      answerInput(["tests"], "   "),
      answerInput([]),
      answerInput(["tests", "tests"]),
    ]) {
      expect(readAskQuestionAnswers(invalid, questions)).toBeUndefined();
    }
  });

  test("reads pending snapshots and the realtime command payload", () => {
    expect(ANSWER_QUESTIONS_REALTIME_OPERATION).toBe(
      "sessions.answer_questions",
    );
    expect(
      readPendingAskQuestions({
        createdAt: 1,
        executionGeneration: 3,
        id: "request-1",
        questions: MIXED_QUESTIONS.questions,
        toolCallId: "call-1",
      }),
    ).toMatchObject({ executionGeneration: 3, id: "request-1" });
    const payload = realtimeAnswerPayload();
    expect(readAnswerQuestionsRealtimePayload(payload)).toEqual(payload);
    expect(
      readAnswerQuestionsRealtimePayload(
        realtimeAnswerPayload({ forged: true }),
      ),
    ).toBeUndefined();
  });
});
