/* jscpd:ignore-start */
import { describe, expect, test } from "vitest";
import {
  canonicalAskQuestionsResult,
  readAskQuestionAnswers,
  readAskQuestionsInput,
} from "../../shared/ask-questions.ts";

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
      options: [
        { label: "Tests", value: "tests" },
        { label: "Types", value: "types" },
        { label: "Lint", value: "lint" },
      ],
      prompt: "Which checks should run?",
      type: "multi_choice",
    },
  ],
};

describe("ask_questions parsing", () => {
  test("reads bounded mixed questions and canonicalizes answers in question order", () => {
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
    expect(canonicalAskQuestionsResult(answers)).toBe(
      '{\n  "answers": [\n    {\n      "questionId": "summary",\n      "value": "Ship it"\n    },\n    {\n      "questionId": "format",\n      "value": "markdown"\n    },\n    {\n      "questionId": "checks",\n      "value": [\n        "types",\n        "tests"\n      ]\n    }\n  ]\n}',
    );
  });

  test("rejects unbounded text, duplicate identities, unknown fields, and invalid selection bounds", () => {
    expect(
      readAskQuestionsInput({
        questions: [{ id: "text", prompt: "Unbounded", type: "free_text" }],
      }),
    ).toBeUndefined();
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "text",
            maxLength: 10,
            prompt: "Unexpected field",
            type: "free_text",
            unexpected: true,
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "choice",
            options: [
              { label: "One", unexpected: true, value: "one" },
              { label: "Two", value: "two" },
            ],
            prompt: "Unexpected option field",
            type: "single_choice",
          },
        ],
      }),
    ).toBeUndefined();
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
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "too-many-options",
            options: Array.from({ length: 13 }, (_, index) => ({
              label: `Option ${String(index)}`,
              value: `option-${String(index)}`,
            })),
            prompt: "Too many options",
            type: "single_choice",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "too-long",
            maxLength: 4_001,
            prompt: "Text limit too high",
            type: "free_text",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "choice",
            options: [
              { label: "One", value: "same" },
              { label: "Two", value: "same" },
            ],
            prompt: "Duplicate values",
            type: "single_choice",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      readAskQuestionsInput({
        questions: [
          {
            id: "many",
            maxSelections: 1,
            minSelections: 2,
            options: [
              { label: "One", value: "one" },
              { label: "Two", value: "two" },
            ],
            prompt: "Impossible bounds",
            type: "multi_choice",
          },
        ],
      }),
    ).toBeUndefined();
  });

  test("requires exactly one valid answer for every question", () => {
    const questions = readAskQuestionsInput(MIXED_QUESTIONS)?.questions ?? [];

    for (const invalid of [
      { answers: [] },
      {
        answers: [
          { questionId: "summary", value: "ok" },
          { questionId: "format", value: "html" },
          { questionId: "checks", value: ["tests"] },
        ],
      },
      {
        answers: [
          { questionId: "summary", value: "long enough" },
          { questionId: "format", value: "markdown" },
          { questionId: "checks", value: [] },
        ],
      },
      {
        answers: [
          { questionId: "summary", value: "long enough" },
          { questionId: "format", value: "markdown" },
          { questionId: "checks", value: ["tests", "tests"] },
        ],
      },
    ]) {
      expect(readAskQuestionAnswers(invalid, questions)).toBeUndefined();
    }
  });
});
/* jscpd:ignore-end */
