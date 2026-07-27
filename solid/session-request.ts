import type { PendingAskQuestions } from "../shared/ask-questions.ts";

export interface SessionQuestionSubmissionState {
  readonly answeringQuestions: boolean;
  readonly error?: unknown;
  readonly pendingQuestions: PendingAskQuestions | null;
}

function questionSubmission(
  state: SessionQuestionSubmissionState,
  requestId: string,
  patch: Partial<SessionQuestionSubmissionState>,
): SessionQuestionSubmissionState {
  return state.pendingQuestions?.id === requestId
    ? { ...state, ...patch }
    : state;
}

function questionSubmissionPatch(
  answeringQuestions: boolean,
  pendingQuestions?: null,
): Partial<SessionQuestionSubmissionState> {
  return {
    answeringQuestions,
    error: undefined,
    ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
  };
}

export function questionSubmissionStarted(
  state: SessionQuestionSubmissionState,
  requestId: string,
): SessionQuestionSubmissionState {
  const patch = questionSubmissionPatch(true);
  return questionSubmission(state, requestId, patch);
}

export function questionSubmissionSucceeded(
  state: SessionQuestionSubmissionState,
  requestId: string,
): SessionQuestionSubmissionState {
  return questionSubmission(
    state,
    requestId,
    questionSubmissionPatch(false, null),
  );
}

export function questionSubmissionFailed(
  state: SessionQuestionSubmissionState,
  requestId: string,
  error: unknown,
): SessionQuestionSubmissionState {
  return questionSubmission(state, requestId, {
    answeringQuestions: false,
    error,
  });
}

/** Ignore stale realtime question snapshots by generation, timestamp, then ID. */
export function reconcilePendingQuestions(
  current: PendingAskQuestions | null,
  incoming: PendingAskQuestions | null,
): PendingAskQuestions | null {
  if (current === null || incoming === null) {
    return incoming;
  }
  if (incoming.executionGeneration !== current.executionGeneration) {
    return incoming.executionGeneration > current.executionGeneration
      ? incoming
      : current;
  }
  if (incoming.createdAt !== current.createdAt) {
    return incoming.createdAt > current.createdAt ? incoming : current;
  }
  return incoming.id >= current.id ? incoming : current;
}
