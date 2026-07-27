import type { PendingAskQuestions } from "../../shared/ask-questions.ts";
import { TEST_DIRECTION_OPTIONS } from "../../shared/test/ask-questions-fixtures.ts";

export function singleChoicePendingQuestions(
  id: string,
  executionGeneration: number,
  createdAt: number,
): PendingAskQuestions {
  return {
    createdAt,
    executionGeneration,
    id,
    questions: [
      {
        id: "direction",
        options: TEST_DIRECTION_OPTIONS,
        prompt: "What next?",
        type: "single_choice",
      },
    ],
    toolCallId: "call-1",
  };
}

export const PENDING_QUESTIONS_FIXTURE: PendingAskQuestions = {
  createdAt: 1,
  executionGeneration: 2,
  id: "request-1",
  questions: [
    {
      id: "detail",
      maxLength: 20,
      minLength: 1,
      prompt: "Add context",
      type: "free_text",
    },
    {
      id: "direction",
      options: TEST_DIRECTION_OPTIONS,
      prompt: "Choose a direction",
      type: "single_choice",
    },
    {
      id: "checks",
      maxSelections: 1,
      minSelections: 1,
      options: [
        { label: "Tests", value: "tests" },
        { label: "Lint", value: "lint" },
      ],
      prompt: "Choose one check",
      type: "multi_choice",
    },
  ],
  toolCallId: "call-1",
};
