import type { AgentSessionDetail } from "../shared/session-model.ts";
import { isAskQuestionsPause } from "./ask-questions-pause.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { FinishSession } from "./session-launcher.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import { sessionHasStatus } from "./session-status.ts";
import type { SessionStore } from "./session-store.ts";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

interface SessionFinisherOptions {
  readonly actions: Pick<SessionAgentActions, "finished" | "stopChildren">;
  readonly cleanup?: (detail: AgentSessionDetail) => void;
  readonly launchQueued?: (userId: string) => Promise<void> | void;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly settled?: (sessionId: string) => Promise<void>;
  readonly store: SessionStore;
}

export class SessionFinisher {
  readonly #options: SessionFinisherOptions;

  constructor(options: SessionFinisherOptions) {
    this.#options = options;
  }

  #afterNotify(
    detail: AgentSessionDetail,
    userId: string,
    action: "finished" | "launch_queued",
  ): void {
    this.#options.notify(userId, detail.id);
    if (action === "finished") {
      this.#options.actions.finished(detail, userId);
    } else {
      this.#launchAfterSettlement(detail.id, userId);
    }
  }

  finish(
    detail: AgentSessionDetail,
    userId: string,
    ...result: [error?: unknown, recovered?: RestartHandoffIdentity]
  ): ReturnType<FinishSession> {
    const notifyFinished = () => {
      this.#afterNotify(detail, userId, "finished");
    };
    const launchQueued = () => {
      this.#afterNotify(detail, userId, "launch_queued");
    };
    const [error, recovered] = result;
    if (isAskQuestionsPause(error)) {
      notifyFinished();
      return;
    }
    this.#options.cleanup?.(detail);
    const current = this.#options.store.get(userId, detail.id);
    if (current?.runnerRequired === true || current?.status === "stopped") {
      notifyFinished();
      return;
    }
    const now = this.#options.now();
    const errorMessage =
      error === undefined ? undefined : safeErrorMessage(error);
    if (
      errorMessage === undefined &&
      recovered === undefined &&
      sessionHasStatus(current, "queued")
    ) {
      launchQueued();
      return;
    }
    if (errorMessage === undefined && recovered === undefined) {
      const next = this.#options.store.settleNormalBoundary(
        detail.id,
        now,
        detail.generation,
      );

      if (sessionHasStatus(next, "queued")) {
        launchQueued();
        return;
      }
    }
    if (recovered !== undefined) {
      const settlement =
        errorMessage === undefined
          ? { status: "idle" as const }
          : { error: errorMessage, status: "failed" as const };
      const settled =
        this.#options.store.settleRestartHandoff(
          userId,
          recovered,
          settlement,
          now,
        ) ||
        (settlement.status === "failed" &&
          this.#options.store.failRestartHandoff(
            userId,
            recovered,
            settlement.error,
            now,
          ));
      if (!settled) {
        return;
      }
      if (settlement.status === "failed") {
        this.#options.actions.stopChildren(detail, userId);
      }
      notifyFinished();
      return;
    }
    if (errorMessage !== undefined) {
      const failed = this.#options.store.settleRuntimeFailure(
        detail.id,
        errorMessage,
        now,
        detail.generation,
      );
      if (failed) this.#options.actions.stopChildren(detail, userId);
      notifyFinished();
      return;
    }
    notifyFinished();
  }

  #launchAfterSettlement(sessionId: string, userId: string): void {
    const settled = this.#options.settled?.(sessionId) ?? Promise.resolve();
    void settled.then(() => this.#options.launchQueued?.(userId));
  }
}
