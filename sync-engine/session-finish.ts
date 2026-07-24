import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

// cpd-ignore-start -- Dependency contracts remain local to each session orchestration boundary.
export interface SessionFinishDependencies {
  readonly actionsFinished: (
    detail: AgentSessionDetail,
    userId: string,
  ) => void;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly rerun: (detail: AgentSessionDetail) => Promise<void>;
  readonly runners: Pick<RunnerIntegration, "runnerIsAvailable">;
  readonly runtimes: Pick<SessionRuntimes, "draining">;
  readonly store: SessionStore;
}
// cpd-ignore-end

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function notifyFinished(
  dependencies: SessionFinishDependencies,
  detail: AgentSessionDetail,
  userId: string,
): void {
  dependencies.notify(userId, detail.id);
  dependencies.actionsFinished(detail, userId);
}

export async function finishSession(
  dependencies: SessionFinishDependencies,
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  userId: string,
  error?: unknown,
): Promise<void> {
  const current = dependencies.store.get(userId, detail.id);
  if (current?.status === "stopped") {
    notifyFinished(dependencies, detail, userId);
    return;
  }
  if (error !== undefined) {
    dependencies.store.appendErrorMessage(
      detail.id,
      safeErrorMessage(error),
      dependencies.now(),
    );
  }
  const next =
    error === undefined
      ? dependencies.store.settleNormalBoundary(detail.id, dependencies.now())
      : undefined;
  if (error !== undefined) {
    dependencies.store.mark(detail.id, "failed", dependencies.now());
  }
  if (next?.status === "running") {
    const running = dependencies.store.get(userId, detail.id);
    if (running !== undefined) {
      await dependencies.rerun(running);
    }
    return;
  }
  if (next?.status === "queued" && !dependencies.runtimes.draining) {
    const queued = dependencies.store.get(userId, detail.id);
    if (
      queued !== undefined &&
      dependencies.runners.runnerIsAvailable(userId, queued.runnerId) &&
      dependencies.launch(queued, credential, userId)
    ) {
      dependencies.notify(userId, detail.id);
      return;
    }
  }
  notifyFinished(dependencies, detail, userId);
}
