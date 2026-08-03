import { and, eq, sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { RestartHandoff } from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import { sessionSegment } from "./session-segment.ts";
import { runningCondition } from "./session-store-persistence.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  storedUserMessageValues,
} from "./session-store-values.ts";
import {
  settleTerminalRuntime,
  terminalRuntimeCondition,
} from "./session-terminal-store.ts";
import { rotateSessionTurn } from "./session-turn-store.ts";
import { runtimeUsageValues } from "./session-usage-values.ts";

const COMPACTION_MESSAGE_PREFIX = "Conversation compacted:\n\n";

function compactionMessage(summary: string): string {
  return `${COMPACTION_MESSAGE_PREFIX}${summary}`;
}

export function compactStoredConversation(options: {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly generation: number;
  readonly restartHandoff?: RestartHandoff | null;
  readonly settle?: boolean;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly summary: string;
  readonly usage: CompactionUsage;
}): void {
  options.database.transaction((transaction) => {
    const condition =
      options.settle === true
        ? terminalRuntimeCondition({
            generation: options.generation,
            restartHandoff: options.restartHandoff ?? null,
            sessionId: options.sessionId,
          })
        : runningCondition(options.sessionId, undefined, options.generation);
    const currentSegment = sessionSegment(transaction, condition);
    const userId = requireRunningSessionUserId(transaction, condition);
    if (currentSegment === undefined) {
      throw new DOMException("The agent session was stopped", "AbortError");
    }
    const nextSegment = currentSegment + 1;

    const advanced = transaction
      .update(agentSessions)
      .set({
        currentContextTokens: 0,
        currentSegment: sql`${agentSessions.currentSegment} + 1`,
        ...runtimeUsageValues(options.usage),
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(and(condition, eq(agentSessions.currentSegment, currentSegment)))
      .returning({ segment: agentSessions.currentSegment })
      .get();
    if (advanced.segment !== nextSegment) {
      throw new DOMException("The agent session was stopped", "AbortError");
    }
    const nextTurnId = rotateSessionTurn({
      database: transaction,
      executionGeneration: options.generation,
      generateId: options.generateId,
      now: options.now,
      previousExecutionGeneration: options.generation,
      segment: nextSegment,
      sessionId: options.sessionId,
      startedAt: options.startedAt,
      userId,
    });
    transaction
      .update(agentMessages)
      .set({
        isDeleted: true,
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(
        and(
          eq(agentMessages.sessionId, options.sessionId),
          eq(agentMessages.segment, currentSegment),
          eq(agentMessages.isDeleted, false),
        ),
      )
      .run();
    retireManualCompactionOperations(
      transaction,
      options.sessionId,
      options.generation,
      options.now,
      "exact",
    );
    const handoff = {
      database: transaction,
      generateId: options.generateId,
      message: {
        ...storedUserMessageValues(compactionMessage(options.summary)),
        turnId: nextTurnId,
      },
      now: options.now,
      segment: nextSegment,
      sessionId: options.sessionId,
      userId,
    };
    appendSystemStoredMessage(handoff);
    if (options.settle === true) {
      settleTerminalRuntime(
        transaction,
        condition,
        "idle",
        options.now,
        options.sessionId,
      );
    }
  });
}
