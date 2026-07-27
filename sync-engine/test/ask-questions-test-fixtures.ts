import {
  readAskQuestionsInput,
  type AskQuestionAnswers,
  type PendingAskQuestions,
} from "../../shared/ask-questions.ts";
import { TEST_DIRECTION_OPTIONS } from "../../shared/test/ask-questions-fixtures.ts";

export const TEST_QUESTION_OPTIONS = TEST_DIRECTION_OPTIONS;

const INPUT_VALUE = {
  questions: [
    {
      id: "decision",
      options: TEST_QUESTION_OPTIONS,
      prompt: "What next?",
      type: "single_choice" as const,
    },
  ],
};

export function testAskQuestionsInput() {
  const input = readAskQuestionsInput(INPUT_VALUE);
  if (input === undefined) {
    throw new Error("The test ask_questions input is invalid");
  }
  return input;
}

export const TEST_PENDING_QUESTIONS: PendingAskQuestions = {
  createdAt: 3,
  executionGeneration: 0,
  id: "request-1",
  questions: [
    {
      id: "direction",
      options: INPUT_VALUE.questions[0]?.options ?? [],
      prompt: "What next?",
      type: "single_choice",
    },
  ],
  toolCallId: "call-1",
};

export const TEST_QUESTION_ANSWERS: AskQuestionAnswers = {
  answers: [{ questionId: "decision", value: "proceed" }],
};
