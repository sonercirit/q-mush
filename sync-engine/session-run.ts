import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import {
  sessionModelRuntime,
  type SessionModelRuntimeResources,
} from "./session-model-runtime.ts";
import type { RestartRequest } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";

// cpd-ignore-start -- Session orchestration boundaries intentionally repeat dependency contracts.
interface RunPersistedSessionOptions {
  readonly actions: SessionAgentActions;
  readonly compact: boolean;
  readonly controller: AbortController;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly finish: (
    detail: AgentSessionDetail,
    userId: string,
    error?: unknown,
  ) => void;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly resources: SessionModelRuntimeResources;
  readonly restartRequest: () => RestartRequest | undefined;
  readonly store: SessionStore;
  readonly userId: string;
}
// cpd-ignore-end

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function runPersistedSession(
  options: RunPersistedSessionOptions,
): Promise<void> {
  if (!options.store.mark(options.detail.id, "running", options.now())) {
    return;
  }
  options.store.completeRestartHandoff(options.detail.id);
  options.notify(options.userId, options.detail.id);
  try {
    const runtime = sessionModelRuntime(
      options.resources,
      options.detail,
      options.credential,
      options.userId,
      options.controller,
      () => options.restartRequest() !== undefined,
    );
    const outcome = await (options.compact
      ? compactSessionConversation(runtime)
      : runSessionAgent(runtime));
    if (outcome === "handoff") {
      const handoff = options.restartRequest();
      if (handoff === undefined) {
        throw new Error("The restart handoff request was lost");
      }
      if (
        !options.store.pauseForRestart(
          options.detail.id,
          handoff.requestedBy,
          handoff.restartId,
          options.now(),
        )
      ) {
        const current = options.store.get(options.userId, options.detail.id);
        if (current?.status !== "stopped") {
          throw new Error("The restart handoff could not be persisted");
        }
      }
      options.notify(options.userId, options.detail.id);
    } else {
      options.finish(options.detail, options.userId);
      options.store.finishRestartHandoff(options.detail.id);
    }
  } catch (error) {
    if (!options.controller.signal.aborted && !isAbort(error)) {
      options.finish(options.detail, options.userId, error);
    }
  }
}
