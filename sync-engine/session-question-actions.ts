import {
  readAnswerQuestionsRealtimePayload,
  readAskQuestionAnswers,
  type AnswerQuestionsRealtimePayload,
  type AskQuestionAnswers,
} from "../shared/ask-questions.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createTaggedRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AskQuestionsStore } from "./ask-questions-store.ts";
import type {
  RecoverableQuestionIdentity,
  SessionLifecycleDependencies,
} from "./session-lifecycle-types.ts";

export type QuestionActionFailure = ReturnType<
  typeof createQuestionActionFailure
>;

function createQuestionActionFailure(code: string) {
  return createTaggedRealtimeCommandError(
    code,
    undefined,
    "question_action_failure",
    "QuestionActionFailure",
  );
}

export function isQuestionActionFailure(
  error: unknown,
): error is QuestionActionFailure {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "question_action_failure"
  );
}

export type AnsweredQuestionLaunch = RecoverableQuestionIdentity;

export interface SessionQuestionActionDependencies extends SessionLifecycleDependencies {
  readonly launchAnswered: (
    answered: AnsweredQuestionLaunch,
  ) => boolean | Promise<boolean>;
  readonly ownsSession?: (
    userId: string,
    sessionId: string,
    workspaceId: string | undefined,
  ) => boolean;
  readonly questions: Pick<
    AskQuestionsStore,
    | "answer"
    | "claimAnswered"
    | "input"
    | "recoverable"
    | "releaseAnsweredClaim"
  >;
}

function answerFailure(status: "conflict" | "not_found" | "stale"): never {
  switch (status) {
    case "conflict":
      throw createQuestionActionFailure("question_answer_conflict");
    case "not_found":
      throw createQuestionActionFailure("not_found");
    case "stale":
      throw createQuestionActionFailure("question_request_stale");
  }
}

function validAnswers(
  dependencies: SessionQuestionActionDependencies,
  userId: string,
  payload: AnswerQuestionsRealtimePayload,
): AskQuestionAnswers {
  if (
    dependencies.ownsSession?.(
      userId,
      payload.sessionId,
      payload.workspaceId,
    ) === false
  ) {
    throw createQuestionActionFailure("not_found");
  }
  const input = dependencies.questions.input(
    userId,
    payload.sessionId,
    payload.requestId,
  );
  const answers =
    input === undefined
      ? undefined
      : readAskQuestionAnswers({ answers: payload.answers }, input.questions);
  if (answers === undefined) {
    throw createQuestionActionFailure(
      input === undefined ? "not_found" : "invalid_request",
    );
  }
  return answers;
}

/**
 * Authenticated realtime command core for sessions.answer_questions.
 * Transport authentication must happen immediately before this call.
 */
export async function answerSessionQuestionsCommand(
  dependencies: SessionQuestionActionDependencies,
  user: AuthenticatedUser,
  value: unknown,
): Promise<{
  readonly launchStarted: boolean;
  readonly result: string;
  readonly status: "already_answered" | "answered";
}> {
  const payload = readAnswerQuestionsRealtimePayload(value);
  if (payload === undefined) {
    throw createQuestionActionFailure("invalid_request");
  }
  const answers = validAnswers(dependencies, user.id, payload);
  const answered = dependencies.questions.answer(
    user.id,
    payload.sessionId,
    payload.requestId,
    answers,
    dependencies.now(),
  );
  switch (answered.status) {
    case "conflict":
    case "not_found":
    case "stale":
      return answerFailure(answered.status);
    case "already_answered":
      return {
        launchStarted: false,
        result: answered.result,
        status: answered.status,
      };
    case "answered": {
      dependencies.notify(user.id, payload.sessionId);
      const launchStarted = await dependencies.launchAnswered({
        executionGeneration: answered.request.executionGeneration,
        requestId: answered.request.id,
        sessionId: answered.request.sessionId,
        userId: answered.request.userId,
      });
      return {
        launchStarted,
        result: answered.result,
        status: answered.status,
      };
    }
  }
}

export async function recoverAnsweredQuestions(
  dependencies: SessionQuestionActionDependencies,
  runnerId?: string,
): Promise<number> {
  let launches = 0;
  for (const recoverable of dependencies.questions.recoverable(runnerId)) {
    if (await dependencies.launchAnswered(recoverable)) {
      launches += 1;
    }
  }
  return launches;
}

function updateAnsweredQuestionClaim(
  dependencies: Pick<SessionQuestionActionDependencies, "now" | "questions">,
  answered: AnsweredQuestionLaunch,
  update: AskQuestionsStore["claimAnswered"],
): boolean {
  return update.call(
    dependencies.questions,
    answered.userId,
    answered.sessionId,
    answered.requestId,
    dependencies.now(),
  );
}

type AnsweredQuestionClaimAction = (
  dependencies: Pick<SessionQuestionActionDependencies, "now" | "questions">,
  answered: AnsweredQuestionLaunch,
) => boolean;

function questionClaimAction(
  selectUpdate: (
    questions: SessionQuestionActionDependencies["questions"],
  ) => AskQuestionsStore["claimAnswered"],
): AnsweredQuestionClaimAction {
  return (dependencies, answered) =>
    updateAnsweredQuestionClaim(
      dependencies,
      answered,
      selectUpdate(dependencies.questions),
    );
}

export const releaseAnsweredQuestionClaim = questionClaimAction(
  (questions) => questions.releaseAnsweredClaim,
);

export const claimAnsweredQuestion = questionClaimAction(
  (questions) => questions.claimAnswered,
);
