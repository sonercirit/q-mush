import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";
import type { SessionCredentialOperation } from "./session-credential-operation.ts";
import {
  claimAnsweredQuestion,
  releaseAnsweredQuestionClaim,
  type AnsweredQuestionLaunch,
} from "./session-question-actions.ts";
import {
  sessionRunnerIsAvailable,
  type SessionQuestionLaunchBoundary,
} from "./session-runner-availability.ts";
import type { SessionStore } from "./session-store-interface.ts";

interface AnsweredQuestionLauncherDependencies extends SessionQuestionLaunchBoundary {
  readonly launch: (
    detail: AgentSessionDetail,
    credential: Parameters<SessionCredentialAction>[0],
    userId: string,
  ) => boolean;
  readonly store: Pick<SessionStore, "get">;
  readonly withCredential: SessionCredentialOperation;
}

export async function launchAnsweredQuestionSession(
  dependencies: AnsweredQuestionLauncherDependencies,
  answered: AnsweredQuestionLaunch,
): Promise<boolean> {
  try {
    await dependencies.runtimes.settled(answered.sessionId);
    const detail = dependencies.store.get(answered.userId, answered.sessionId);
    if (
      detail?.generation !== answered.executionGeneration ||
      detail.status !== "queued" ||
      !sessionRunnerIsAvailable(
        dependencies.runnerIsAvailable,
        answered.userId,
        detail,
      )
    ) {
      return false;
    }
    const launched = await dependencies.withCredential(
      answered.userId,
      detail,
      (credential) => {
        if (!claimAnsweredQuestion(dependencies.questions, answered)) {
          return createApiError("question_request_stale", 409);
        }
        if (dependencies.launch(detail, credential, answered.userId)) {
          return createJsonResponse({ status: "launched" });
        }
        releaseAnsweredQuestionClaim(dependencies.questions, answered);
        return createApiError("session_launch_failed", 500);
      },
    );
    return launched.ok;
  } catch {
    return false;
  }
}
