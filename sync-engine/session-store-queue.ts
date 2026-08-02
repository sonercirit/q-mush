import { eq, sql } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionExecutionIsCurrent,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
import {
  activePendingInput,
  promotePendingInput,
} from "./session-pending-inputs.ts";
import { storedSessionRunnerIsAvailable } from "./session-runner-availability-store.ts";
import {
  activeSessionCondition,
  type SessionFilter,
} from "./session-store-persistence.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { readStoredSessionResult } from "./session-store-result.ts";
import { readStoredSessionState } from "./session-store-state.ts";
import { userMessageValues } from "./session-store-values.ts";
import { rotateSessionTurn } from "./session-turn-store.ts";

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
    const stored = readStoredSessionState(
      transaction,
      activeSessionCondition(
        queueSessionFilter(sessionId, userId, workspaceId),
      ),
    );

    if (stored === undefined) {
      return "not_found" as const;
    }
    if (
      authorization?.targetGeneration !== undefined &&
      authorization.targetGeneration !== stored.executionGeneration
    ) {
      return "busy" as const;
    }
    if (!["completed", "idle", "failed", "stopped"].includes(stored.status)) {
      return "busy" as const;
    }
    if (stored.runnerRequired) {
      return "runner_required" as const;
    }
    if (!storedSessionRunnerIsAvailable(transaction, userId, sessionId, now)) {
      return "runner_unavailable" as const;
    }

    const pending = activePendingInput(transaction, sessionId);
    if (pending !== undefined && prompt !== undefined) {
      return "pending_input_conflict" as const;
    }

    const turnId = rotateSessionTurn({
      database: transaction,
      executionGeneration: stored.executionGeneration + 1,
      generateId:
        prompt !== undefined && messageId !== undefined
          ? () => messageId
          : resources.generateId,
      now,
      previousExecutionGeneration: stored.executionGeneration,
      segment: stored.currentSegment,
      sessionId,
      userId,
    });
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
            turnId,
            userId,
          }),
        )
        .run();
    }
    if (pending !== undefined) {
      promotePendingInput(
        transaction,
        pending,
        userId,
        now,
        stored.currentSegment,
        turnId,
      );
    }
    transaction
      .update(agentSessions)
      .set({
        activeStartedAt: null,
        executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
        parentExecutionGeneration: null,
        status: "queued",
        ...updatedAuditFields(userId, now),
      })
      .where(eq(agentSessions.id, sessionId))
      .run();
    return "queued" as const;
  });

  if (status !== "queued") {
    return { status };
  }
  return readStoredSessionResult(
    resources,
    userId,
    sessionId,
    "queued",
    "The queued agent session could not be read",
  );
}
