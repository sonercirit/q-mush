import { describe, expect, test, vi } from "vitest";
import type { AskQuestionsStore } from "../../sync-engine/ask-questions-store.ts";
import {
  claimAnsweredQuestion,
  recoverAnsweredQuestions,
  releaseAnsweredQuestionClaim,
} from "../../sync-engine/session-question-actions.ts";

const RECOVERABLE = {
  executionGeneration: 4,
  requestId: "request-1",
  sessionId: "session-1",
  userId: "user-1",
};

function recoveryQuestions(options: {
  readonly claim?: boolean;
  readonly recoverable?: readonly (typeof RECOVERABLE)[];
  readonly release?: boolean;
}): Pick<
  AskQuestionsStore,
  "answer" | "claimAnswered" | "input" | "recoverable" | "releaseAnsweredClaim"
> {
  return {
    answer: vi.fn(),
    claimAnswered: vi.fn(() => options.claim ?? true),
    input: vi.fn(),
    recoverable: vi.fn(() => options.recoverable ?? [RECOVERABLE]),
    releaseAnsweredClaim: vi.fn(() => options.release ?? true),
  };
}

function answeredQuestionOperation(
  action: "claim" | "release",
  now: number,
  questions: ReturnType<typeof recoveryQuestions>,
): boolean {
  const dependencies = { now: () => now, questions };
  return action === "claim"
    ? claimAnsweredQuestion(dependencies, RECOVERABLE)
    : releaseAnsweredQuestionClaim(dependencies, RECOVERABLE);
}

function expectAnsweredQuestionCall(
  operation: AskQuestionsStore["claimAnswered"],
  now: number,
): void {
  expect(operation).toHaveBeenCalledWith(
    RECOVERABLE.userId,
    RECOVERABLE.sessionId,
    RECOVERABLE.requestId,
    now,
  );
}

function recoverQuestions(
  questions: ReturnType<typeof recoveryQuestions>,
  launchAnswered: () => boolean,
  runnerId?: string,
): Promise<number> {
  return recoverAnsweredQuestions(
    { launchAnswered, notify: vi.fn(), now: () => 10, questions },
    runnerId,
  );
}

describe("answered question recovery", () => {
  test("rediscovers durable answered work after restart", async () => {
    const questions = recoveryQuestions({});
    const launchAnswered = vi.fn(() => true);
    const launched = await recoverQuestions(questions, launchAnswered);

    expect(launched).toBe(1);
    expect(launchAnswered).toHaveBeenCalledWith(RECOVERABLE);
  });

  test("can scope recovery to a reconnecting runner", async () => {
    const questions = recoveryQuestions({});
    await recoverQuestions(questions, () => false, "runner-1");
    expect(questions.recoverable).toHaveBeenCalledWith("runner-1");
  });

  test("claims the exact answered request before resumed execution", () => {
    const questions = recoveryQuestions({ claim: true });
    expect(answeredQuestionOperation("claim", 11, questions)).toBe(true);
    expectAnsweredQuestionCall(questions.claimAnswered, 11);
  });

  test("releases the exact answered request after a refused launch", () => {
    const questions = recoveryQuestions({ release: true });
    expect(answeredQuestionOperation("release", 12, questions)).toBe(true);
    expectAnsweredQuestionCall(questions.releaseAnsweredClaim, 12);
  });

  test("does not report refused launches as recovered", async () => {
    const questions = recoveryQuestions({});
    await expect(recoverQuestions(questions, () => false)).resolves.toBe(0);
  });
});
