import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import { runningCondition } from "./session-store-reassignment.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  storedUserMessageValues,
} from "./session-store-values.ts";
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
  readonly sessionId: string;
  readonly summary: string;
  readonly usage: CompactionUsage;
}): void {
  options.database.transaction((transaction) => {
    const condition = runningCondition(
      options.sessionId,
      undefined,
      options.generation,
    );
    const setSession = transaction
      .update(agentSessions)
      .set({
        currentContextTokens: 0,
        ...runtimeUsageValues(options.usage),
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(condition);
    const userId = requireRunningSessionUserId(transaction, condition);

    setSession.run();
    transaction
      .update(agentMessages)
      .set({
        isDeleted: true,
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(
        and(
          eq(agentMessages.sessionId, options.sessionId),
          eq(agentMessages.isDeleted, false),
        ),
      )
      .run();
    const handoff = {
      database: transaction,
      generateId: options.generateId,
      message: storedUserMessageValues(compactionMessage(options.summary)),
      now: options.now,
      sessionId: options.sessionId,
      userId,
    };
    appendSystemStoredMessage(handoff);
  });
}
