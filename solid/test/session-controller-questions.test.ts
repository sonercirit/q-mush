import { describe, expect, test } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  questionSubmissionFailed,
  questionSubmissionStarted,
  questionSubmissionSucceeded,
  reconcilePendingQuestions,
  type SessionQuestionSubmissionState,
} from "../session-request.ts";
import { singleChoicePendingQuestions } from "./ask-questions-fixtures.ts";

function pending(id: string, executionGeneration: number, createdAt: number) {
  return singleChoicePendingQuestions(id, executionGeneration, createdAt);
}

describe("session question controller surface", () => {
  test("uses the authenticated question-answer realtime operation", () => {
    expect(SESSION_REALTIME_OPERATIONS.answerQuestions).toBe(
      "sessions.answer_questions",
    );
  });

  test("keeps pending state scoped to the request being submitted", () => {
    const initial: SessionQuestionSubmissionState = {
      answeringQuestions: false,
      pendingQuestions: pending("request-1", 2, 10),
    };
    expect(questionSubmissionStarted(initial, "stale-request")).toBe(initial);
    const started = questionSubmissionStarted(initial, "request-1");
    expect(started).toMatchObject({ answeringQuestions: true });
    expect(questionSubmissionSucceeded(started, "request-1")).toMatchObject({
      answeringQuestions: false,
      pendingQuestions: null,
    });
    expect(
      questionSubmissionFailed(started, "request-1", new Error("offline")),
    ).toMatchObject({
      answeringQuestions: false,
      pendingQuestions: initial.pendingQuestions,
    });
  });

  test("ignores stale pending question snapshots", () => {
    const current = pending("request-new", 4, 20);
    expect(reconcilePendingQuestions(current, pending("old", 3, 100))).toBe(
      current,
    );
    expect(
      reconcilePendingQuestions(current, pending("older-time", 4, 10)),
    ).toBe(current);
    expect(
      reconcilePendingQuestions(current, pending("request-next", 5, 1)),
    ).toMatchObject({ id: "request-next" });
    expect(reconcilePendingQuestions(current, null)).toBeNull();
  });
});
