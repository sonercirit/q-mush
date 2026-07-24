import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import {
  sessionModelRuntime,
  type SessionModelRuntimeResources,
} from "./session-model-runtime.ts";
import type { SessionStore } from "./session-store.ts";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface SessionExecutionResources extends Omit<
  SessionModelRuntimeResources,
  "actions"
> {
  readonly actions: SessionAgentActions;
  readonly finished: (detail: AgentSessionDetail, userId: string) => void;
  readonly store: SessionStore;
}

function finish(
  resources: SessionExecutionResources,
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

export async function executeSession(options: {
  readonly compact: boolean;
  readonly controller: AbortController;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly resources: SessionExecutionResources;
  readonly userId: string;
}): Promise<void> {
  const { controller, detail, resources, userId } = options;
  if (!resources.store.mark(detail.id, "running", resources.now())) {
    return;
  }
  resources.notify(userId, detail.id);

  try {
    const runtime = sessionModelRuntime(
      resources,
      detail,
      options.credential,
      userId,
      controller,
    );
    await (options.compact
      ? compactSessionConversation(runtime)
      : runSessionAgent(runtime));
    finish(resources, detail, userId);
  } catch (error) {
    if (!controller.signal.aborted && !isAbort(error)) {
      finish(resources, detail, userId, error);
    }
  }
}
