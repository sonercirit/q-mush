import type { AskQuestionAnswers } from "../shared/ask-questions.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { SessionCommandViewOptions } from "./session-controller-options.ts";
import { sessionMutationError } from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";
import {
  questionSubmissionFailed,
  questionSubmissionStarted,
  questionSubmissionSucceeded,
} from "./session-request.ts";

export async function answerSessionQuestions(
  options: SessionCommandViewOptions & {
    readonly answers: AskQuestionAnswers;
  },
): Promise<void> {
  const detail = options.view.value.detail;
  const pending = detail?.pendingQuestions;
  if (
    detail === undefined ||
    pending === null ||
    pending === undefined ||
    sessionMutationPending(options.view.value) ||
    options.view.value.answeringQuestions ||
    options.transport === undefined
  ) {
    return;
  }
  const requestId = pending.id;
  const started = questionSubmissionStarted(
    {
      answeringQuestions: options.view.value.answeringQuestions,
      error: options.view.value.error,
      pendingQuestions: pending,
    },
    requestId,
  );
  const revision = options.view.begin({
    answeringQuestions: started.answeringQuestions,
    error: typeof started.error === "string" ? started.error : undefined,
  });
  options.realtime.rebaseStream(detail.id);
  try {
    await options.transport.command(
      SESSION_REALTIME_OPERATIONS.answerQuestions,
      {
        answers: options.answers.answers,
        requestId,
        sessionId: detail.id,
        ...(detail.workspaceId.length === 0
          ? {}
          : { workspaceId: detail.workspaceId }),
      },
    );
    const settled = questionSubmissionSucceeded(
      {
        answeringQuestions: true,
        error: undefined,
        pendingQuestions: pending,
      },
      requestId,
    );
    options.view.patchCurrent(revision, {
      answeringQuestions: settled.answeringQuestions,
      detail: { ...detail, pendingQuestions: settled.pendingQuestions },
      error: typeof settled.error === "string" ? settled.error : undefined,
    });
  } catch (error) {
    const settled = questionSubmissionFailed(
      {
        answeringQuestions: true,
        error: undefined,
        pendingQuestions: pending,
      },
      requestId,
      error,
    );
    options.view.patchCurrent(revision, {
      answeringQuestions: settled.answeringQuestions,
      error: sessionMutationError(error, "submit those answers"),
    });
  }
}
