import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { AskQuestionsPause } from "./ask-questions-pause.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import {
  sessionModelRuntime,
  type SessionModelRuntimeResources,
} from "./session-model-runtime.ts";

interface SessionRunResources extends SessionModelRuntimeResources {
  readonly finished: (detail: AgentSessionDetail, userId: string) => void;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function runSession(
  resources: SessionRunResources,
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  userId: string,
  controller: AbortController,
  compact: boolean,
): Promise<void> {
  if (!startRun(resources, detail.id, userId)) {
    return;
  }
  resources.notify(userId, detail.id);

  try {
    const runtime = sessionModelRuntime(
      resources,
      detail,
      credential,
      userId,
      controller,
    );
    await (compact
      ? compactSessionConversation(runtime)
      : runSessionAgent(runtime));
    finishRun(resources, detail, userId);
  } catch (error) {
    if (error instanceof AskQuestionsPause) {
      return;
    }
    if (!controller.signal.aborted && !isAbort(error)) {
      finishRun(resources, detail, userId, error);
    }
  }
}

function startRun(
  resources: SessionRunResources,
  sessionId: string,
  userId: string,
): boolean {
  const answered = resources.questions.startAnsweredSession(
    userId,
    sessionId,
    resources.now(),
  );
  if (answered !== undefined) {
    return answered;
  }
  return resources.store.mark(sessionId, "running", resources.now());
}

function finishRun(
  resources: SessionRunResources,
  detail: AgentSessionDetail,
  userId: string,
  error?: unknown,
): void {
  const current = resources.store.get(userId, detail.id);
  if (current?.status === "stopped") {
    resources.finished(detail, userId);
    return;
  }
  if (error !== undefined) {
    resources.store.appendErrorMessage(
      detail.id,
      safeErrorMessage(error),
      resources.now(),
    );
  }
  resources.store.mark(
    detail.id,
    error === undefined ? "idle" : "failed",
    resources.now(),
  );
  resources.finished(detail, userId);
}
