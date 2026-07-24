/* jscpd:ignore-start */
import {
  readAskQuestionAnswers,
  type AskQuestionAnswers,
} from "../shared/ask-questions.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { AskQuestionsStore } from "./ask-questions-store.ts";
import {
  createApiError,
  createJsonResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface QuestionActionDependencies {
  readonly credential: (
    userId: string,
    detail: AgentSessionDetail,
    action: (
      credential: ProviderCredentialAccess,
    ) => Promise<Response> | Response,
  ) => Promise<Response>;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly questions: AskQuestionsStore;
  readonly runners: RunnerIntegration;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}

export async function answerQuestionRequest(
  dependencies: QuestionActionDependencies,
  requests: SessionRequestHelpers,
  request: Request,
  sessionId: string,
  questionRequestId: string,
): Promise<Response> {
  return await Promise.resolve(
    requests.postForUser(request, async (user) => {
      if (dependencies.runtimes.draining) {
        return createApiError("server_restarting", 503);
      }
      const input = dependencies.questions.input(
        user.id,
        sessionId,
        questionRequestId,
      );
      if (input === undefined) {
        return createApiError("not_found", 404);
      }
      const answers = await parseJsonRequest(request, (value) =>
        readAskQuestionAnswers(value, input.questions),
      );
      return answers === undefined
        ? createApiError("invalid_request", 400)
        : answerSessionQuestions(
            dependencies,
            user.id,
            sessionId,
            questionRequestId,
            answers,
          );
    }),
  );
}

async function answerSessionQuestions(
  dependencies: QuestionActionDependencies,
  userId: string,
  sessionId: string,
  requestId: string,
  answers: AskQuestionAnswers,
): Promise<Response> {
  let result: ReturnType<AskQuestionsStore["answer"]>;
  try {
    result = dependencies.questions.answer(
      userId,
      sessionId,
      requestId,
      answers,
      dependencies.now(),
    );
  } catch {
    return createApiError("invalid_request", 400);
  }
  if (result === "not_found") {
    return createApiError("not_found", 404);
  }
  if (result === "conflict") {
    return createApiError("question_answer_conflict", 409);
  }
  const detail = dependencies.store.get(userId, sessionId);
  if (detail === undefined) {
    return createApiError("not_found", 404);
  }
  if (result.status === "already_answered") {
    return createJsonResponse(detail);
  }
  dependencies.notify(userId, sessionId);
  return launchAnsweredSession(dependencies, detail, userId);
}

async function launchAnsweredSession(
  dependencies: QuestionActionDependencies,
  detail: AgentSessionDetail,
  userId: string,
): Promise<Response> {
  await dependencies.runtimes.wait(detail.id);
  const current = dependencies.store.get(userId, detail.id);
  if (current === undefined) {
    return createApiError("not_found", 404);
  }
  if (current.status !== "queued") {
    return createJsonResponse(current);
  }
  if (!dependencies.runners.runnerIsAvailable(userId, current.runnerId)) {
    return createApiError("runner_unavailable", 409);
  }
  const response = await dependencies.credential(
    userId,
    current,
    (credential) =>
      dependencies.launch(current, credential, userId)
        ? createJsonResponse(
            dependencies.store.get(userId, current.id) ?? current,
          )
        : createApiError("server_restarting", 503),
  );
  return response.status === 503 && !dependencies.runtimes.draining
    ? createJsonResponse(dependencies.store.get(userId, current.id) ?? current)
    : response;
}

export function recoverAnsweredQuestions(
  dependencies: QuestionActionDependencies,
): void {
  for (const { id, userId } of dependencies.questions.recoverable()) {
    const detail = dependencies.store.get(userId, id);
    if (
      detail !== undefined &&
      !dependencies.runtimes.active(id) &&
      dependencies.runners.runnerIsAvailable(userId, detail.runnerId)
    ) {
      void dependencies.credential(userId, detail, (credential) => {
        dependencies.launch(detail, credential, userId);
        return createJsonResponse(detail);
      });
    }
  }
}

export function questionDependencies(
  options: QuestionActionDependencies,
): QuestionActionDependencies {
  return options;
}

export type { QuestionActionDependencies };
/* jscpd:ignore-end */
