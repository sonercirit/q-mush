import { eq, sql } from "drizzle-orm";
import type { AgentImage } from "../shared/agent-images.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { storedSessionRunnerIsAvailable } from "./session-runner-availability-store.ts";
import { activeSessionCondition } from "./session-store-reassignment.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { readStoredSessionResult } from "./session-store-result.ts";
import { readStoredSessionState } from "./session-store-state.ts";
import { userMessageValues } from "./session-store-values.ts";

export type QueueSessionResult =
  | { readonly detail: AgentSessionDetail; readonly status: "queued" }
  | {
      readonly status:
        "busy" | "not_found" | "runner_required" | "runner_unavailable";
    };

export function queueStoredSession(options: {
  readonly now: number;
  readonly prompt?: {
    readonly content: string;
    readonly images: readonly AgentImage[];
  };
  readonly resources: SessionStoreWriteResources;
  readonly sessionId: string;
  readonly userId: string;
}): QueueSessionResult {
  const { now, prompt, resources, sessionId, userId } = options;
  const messageId =
    prompt === undefined ? undefined : resources.generateId(now);
  const status = resources.database.transaction((transaction) => {
    const stored = readStoredSessionState(
      transaction,
      activeSessionCondition({ id: sessionId, userId }),
    );

    if (stored === undefined) {
      return "not_found" as const;
    }
    if (!["idle", "failed", "stopped"].includes(stored.status)) {
      return "busy" as const;
    }
    if (stored.runnerRequired) {
      return "runner_required" as const;
    }
    if (!storedSessionRunnerIsAvailable(transaction, userId, sessionId, now)) {
      return "runner_unavailable" as const;
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
            sessionId,
            userId,
          }),
        )
        .run();
    }
    transaction
      .update(agentSessions)
      .set({
        activeStartedAt: null,
        executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
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
    status,
    "The queued agent session could not be read",
  );
}
