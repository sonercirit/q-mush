import {
  readAskQuestionsInput,
  type PendingAskQuestions,
} from "../shared/ask-questions.ts";
import type { AskQuestionsStore } from "./ask-questions-store.ts";
import type { SessionLifecycleDependencies } from "./session-lifecycle-types.ts";

export type AskQuestionsPause = Error & {
  readonly requestId: string;
  readonly tag: "ask_questions_pause";
};

export function createAskQuestionsPause(requestId: string): AskQuestionsPause {
  return Object.assign(
    new Error("The agent session is paused for question answers"),
    {
      name: "AskQuestionsPause",
      requestId,
      tag: "ask_questions_pause" as const,
    },
  );
}

export function isAskQuestionsPause(
  error: unknown,
): error is AskQuestionsPause {
  return (
    error instanceof Error &&
    "tag" in error &&
    error.tag === "ask_questions_pause" &&
    "requestId" in error &&
    typeof error.requestId === "string"
  );
}

export interface AskQuestionsToolInvocation {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly executionGeneration: number;
  readonly selected: boolean;
  readonly sessionId: string;
  readonly source: "direct" | "nested";
  readonly toolCallId: string;
  readonly userId: string;
}

export interface AskQuestionsToolDependencies extends SessionLifecycleDependencies {
  readonly questions: Pick<AskQuestionsStore, "create">;
}

/**
 * Direct runtime hook. A successful invocation persists the pause and throws
 * AskQuestionsPause; rejected invocations return a model-visible error.
 */
export function isAskQuestionsToolName(name: string): boolean {
  return name === "ask_questions";
}

export function pauseForAskQuestions(
  dependencies: AskQuestionsToolDependencies,
  invocation: AskQuestionsToolInvocation,
): string {
  if (!invocation.selected) {
    return "Error: ask_questions is not enabled for this session.";
  }
  if (invocation.source !== "direct") {
    return "Error: ask_questions cannot run inside parallel or another tool.";
  }
  const input = readAskQuestionsInput(invocation.arguments);
  if (input === undefined) {
    return "Error: the ask_questions arguments are invalid.";
  }
  const pending: PendingAskQuestions = dependencies.questions.create(
    invocation.userId,
    invocation.sessionId,
    invocation.executionGeneration,
    invocation.toolCallId,
    input,
    dependencies.now(),
  );
  dependencies.notify(invocation.userId, invocation.sessionId);
  throw createAskQuestionsPause(pending.id);
}
