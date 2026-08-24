import type { AgentSessionDetail } from "../shared/session-model.ts";
import { isAskQuestionsPause } from "./ask-questions-pause.ts";
import { isDiskFullFailure } from "./database-write-resilience.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { FinishSession } from "./session-launcher.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import { sessionHasStatus } from "./session-status.ts";
import type { SessionStore } from "./session-store-interface.ts";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

type FinishResult = [error?: unknown, recovered?: RestartHandoffIdentity];

export interface SessionFailureReconciliation {
  readonly detail: AgentSessionDetail;
  readonly error: unknown;
  readonly recovered?: RestartHandoffIdentity;
  readonly userId: string;
}

interface SessionFinisherOptions {
  readonly actions: Pick<SessionAgentActions, "finished" | "stopChildren">;
  readonly cleanup?: (detail: AgentSessionDetail) => void;
  readonly launchQueued?: (userId: string) => Promise<void> | void;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly reconciliationFailed?: (
    failure: SessionFailureReconciliation,
  ) => void;
  readonly settled?: (sessionId: string) => Promise<void>;
  readonly store: SessionStore;
}

export interface SessionFinisher {
  readonly finish: (
    detail: AgentSessionDetail,
    userId: string,
    ...result: FinishResult
  ) => ReturnType<FinishSession>;
}

export function createSessionFinisher(
  options: SessionFinisherOptions,
): SessionFinisher {
  const launchAfterSettlement = (sessionId: string, userId: string): void => {
    const settled = options.settled?.(sessionId) ?? Promise.resolve();
    void settled.then(() => options.launchQueued?.(userId));
  };
  const afterNotify = (
    detail: AgentSessionDetail,
    userId: string,
    action: "finished" | "launch_queued",
  ): void => {
    options.notify(userId, detail.id);
    if (action === "finished") options.actions.finished(detail, userId);
    else launchAfterSettlement(detail.id, userId);
  };
  const settle = (
    detail: AgentSessionDetail,
    userId: string,
    result: FinishResult,
  ): void => {
    const notifyFinished = () => {
      afterNotify(detail, userId, "finished");
    };
    const launchQueued = () => {
      afterNotify(detail, userId, "launch_queued");
    };
    const [error, recovered] = result;
    if (isAskQuestionsPause(error)) {
      notifyFinished();
      return;
    }
    options.cleanup?.(detail);
    const current = options.store.get(userId, detail.id);
    if (current?.runnerRequired === true || current?.status === "stopped") {
      notifyFinished();
      return;
    }
    const now = options.now();
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
      const next = options.store.settleNormalBoundary(
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
        options.store.settleRestartHandoff(
          userId,
          recovered,
          settlement,
          now,
        ) ||
        (settlement.status === "failed" &&
          options.store.failRestartHandoff(
            userId,
            recovered,
            settlement.error,
            now,
          ));
      if (!settled) return;
      if (settlement.status === "failed")
        options.actions.stopChildren(detail, userId);
      notifyFinished();
      return;
    }
    if (errorMessage !== undefined) {
      const failed = options.store.settleRuntimeFailure(
        detail.id,
        errorMessage,
        now,
        detail.generation,
      );
      if (failed) options.actions.stopChildren(detail, userId);
      notifyFinished();
      return;
    }
    notifyFinished();
  };
  const finish: SessionFinisher["finish"] = (detail, userId, ...result) => {
    try {
      settle(detail, userId, result);
    } catch (settlementError) {
      const [error, recovered] = result;
      if (error !== undefined && isDiskFullFailure(settlementError)) {
        options.reconciliationFailed?.({
          detail,
          error,
          ...(recovered === undefined ? {} : { recovered }),
          userId,
        });
        return;
      }
      throw settlementError;
    }
  };
  return { finish };
}
