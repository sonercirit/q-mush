import type { AgentImage } from "../shared/agent-images.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import { agentMessages } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionExecutionIsCurrent,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
import { advanceStoredSessionGeneration } from "./session-generation-advance.ts";
import {
  activePendingInput,
  promotePendingInput,
} from "./session-pending-inputs.ts";
import { storedSessionRunnerIsAvailable } from "./session-runner-availability-store.ts";
import {
  activeSessionCondition,
  type SessionFilter,
} from "./session-store-persistence.ts";
import {
  emitReportedParent,
  type SessionStoreWriteResources,
} from "./session-store-resources.ts";
import { readStoredSessionResult } from "./session-store-result.ts";
import { readStoredSessionState } from "./session-store-state.ts";
import { userMessageValues } from "./session-store-values.ts";
import { activeDurableSystemPendingInputs } from "./session-system-pending-inputs.ts";

function queueSessionFilter(
  sessionId: string,
  userId: string,
  workspaceId?: string,
): SessionFilter {
  return workspaceId === undefined
    ? { id: sessionId, userId }
    : { id: sessionId, userId, workspaceId };
}

export type QueueSessionResult =
  | {
      readonly detail: AgentSessionDetail;
      readonly status: "queued";
    }
  | {
      readonly status:
        | "busy"
        | "callback_pending"
        | "not_found"
        | "parent_stale"
        | "pending_input_conflict"
        | "runner_required"
        | "runner_unavailable";
    };

export function queueStoredSession(options: {
  readonly authorization?: SessionQueueAuthorization;
  readonly now: number;
  readonly prompt?: {
    readonly content: string;
    readonly images: readonly AgentImage[];
  };
  readonly resources: SessionStoreWriteResources;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId?: string;
}): QueueSessionResult {
  const {
    authorization,
    now,
    prompt,
    resources,
    sessionId,
    userId,
    workspaceId,
  } = options;
  const messageId =
    prompt === undefined ? undefined : resources.generateId(now);
  const status = resources.database.transaction((transaction) => {
    if (
      authorization?.parent !== undefined &&
      !sessionExecutionIsCurrent(transaction, authorization.parent, userId)
    ) {
      return "parent_stale" as const;
    }
    const sessionCondition = activeSessionCondition(
      queueSessionFilter(sessionId, userId, workspaceId),
    );
    const stored = readStoredSessionState(transaction, sessionCondition);
    if (stored === undefined) return "not_found" as const;
    if (stored.runnerRequired) return "runner_required" as const;
    if (
      authorization?.targetGeneration !== undefined &&
      authorization.targetGeneration !== stored.executionGeneration
    ) {
      return "busy" as const;
    }
    if (!["completed", "idle", "failed", "stopped"].includes(stored.status)) {
      return "busy" as const;
    }
    if (!storedSessionRunnerIsAvailable(transaction, userId, sessionId, now)) {
      return "runner_unavailable" as const;
    }

    const durableReports = activeDurableSystemPendingInputs(
      transaction,
      sessionId,
    );
    const pending = activePendingInput(transaction, sessionId);
    if (
      prompt !== undefined &&
      pending !== undefined &&
      !durableReports.some(({ id }) => id === pending.id)
    ) {
      return "pending_input_conflict" as const;
    }
    const advanced = advanceStoredSessionGeneration({
      condition: sessionCondition,
      database: transaction,
      generateId: resources.generateId,
      mode: "attempt",
      now,
      sessionId,
      startTurn: messageId === undefined ? {} : { id: messageId },
      values: {
        activeStartedAt: null,
        stepStartedAt: null,
        interruptedHandoff: null,
        parentExecutionGeneration: stored.parentExecutionGeneration,
        status: "queued",
        ...updatedAuditFields(userId, now),
      },
    });
    if (advanced?.turnId === undefined) {
      return durableReports.length === 0
        ? ("busy" as const)
        : ("callback_pending" as const);
    }
    if (prompt !== undefined && messageId !== undefined) {
      transaction
        .insert(agentMessages)
        .values(
          userMessageValues({
            content: prompt.content,
            id: messageId,
            images: prompt.images,
            now,
            segment: stored.currentSegment,
            sessionId,
            turnId: advanced.turnId,
            userId,
          }),
        )
        .run();
    }
    if (authorization?.deferSystemPendingInputs !== true) {
      for (const durableReport of durableReports) {
        promotePendingInput(
          transaction,
          durableReport,
          userId,
          now,
          stored.currentSegment,
          advanced.turnId,
        );
      }
    }
    const pendingAfterReport = activePendingInput(transaction, sessionId);
    if (
      pendingAfterReport !== undefined &&
      !durableReports.some(({ id }) => id === pendingAfterReport.id)
    ) {
      promotePendingInput(
        transaction,
        pendingAfterReport,
        userId,
        now,
        stored.currentSegment,
        advanced.turnId,
      );
    }
    return {
      report: advanced.reportedParent,
      status: "queued" as const,
    };
  });

  if (typeof status === "string") return { status };
  emitReportedParent(resources, userId, status.report);
  return readStoredSessionResult(
    resources,
    userId,
    sessionId,
    "queued",
    "The queued agent session could not be read",
  );
}
