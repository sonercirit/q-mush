import { and, eq, sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { RestartHandoff } from "../shared/session-model.ts";
import {
  AGENT_COMPACTION_REQUEST_MESSAGE,
  COMPACTION_HANDOFF_INSTRUCTION,
} from "./agent-compaction.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import { sessionSegment } from "./session-segment.ts";
import { runningCondition } from "./session-store-persistence.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  recordedMessageValues,
  storedCompactionRequestValues,
  storedUserMessageValues,
} from "./session-store-values.ts";
import {
  COMPACTION_MESSAGE_PREFIX,
  settleTerminalRuntime,
  terminalRuntimeCondition,
} from "./session-terminal-store.ts";
import { rotateSessionTurn } from "./session-turn-store.ts";
import { runtimeUsageValues } from "./session-usage-values.ts";

function compactionMessage(summary: string): string {
  return `${COMPACTION_MESSAGE_PREFIX}${COMPACTION_HANDOFF_INSTRUCTION}\n\n${summary}`;
}

function compactionTranscriptValues(
  summary: string,
  tokenUsage: CompactionUsage["tokenUsage"],
) {
  return [
    storedCompactionRequestValues(AGENT_COMPACTION_REQUEST_MESSAGE),
    recordedMessageValues(
      { content: summary, role: "assistant", toolCalls: [] },
      tokenUsage,
    ),
  ];
}

function appendCompactionTranscript(options: {
  readonly database: Pick<AppDatabase, "insert" | "select">;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly segment: number;
  readonly sessionId: string;
  readonly summary: string;
  readonly tokenUsage: CompactionUsage["tokenUsage"];
  readonly userId: string;
}): void {
  let now = options.now;
  for (const message of compactionTranscriptValues(
    options.summary,
    options.tokenUsage,
  )) {
    now = appendSystemStoredMessage({ ...options, message, now });
  }
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
        ...runtimeUsageValues(options.usage),
        currentContextTokens: 0,
        currentSegment: sql`${agentSessions.currentSegment} + 1`,
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(and(condition, eq(agentSessions.currentSegment, currentSegment)))
      .returning({ segment: agentSessions.currentSegment })
      .get();
    if (advanced.segment !== nextSegment) {
      throw new DOMException("The agent session was stopped", "AbortError");
    }
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
    appendCompactionTranscript({
      database: transaction,
      generateId: options.generateId,
      now: options.now,
      segment: currentSegment,
      sessionId: options.sessionId,
      summary: options.summary,
      tokenUsage: options.usage.tokenUsage,
      userId,
    });
    const nextTurnId = rotateSessionTurn({
      database: transaction,
      executionGeneration: options.generation,
      generateId: options.generateId,
      now: options.now,
      previousExecutionGeneration: options.generation,
      segment: nextSegment,
      sessionId: options.sessionId,
      startedAt: options.startedAt,
      toolSettings: "inherit",
      userId,
    });
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
    retireManualCompactionOperations(
      transaction,
      options.sessionId,
      options.generation,
      options.now,
      "exact",
    );
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
