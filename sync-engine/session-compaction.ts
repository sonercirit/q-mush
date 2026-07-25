import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { runningCondition } from "./session-store-reassignment.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  storedUserMessageValues,
} from "./session-store-values.ts";

const COMPACTION_MESSAGE_PREFIX = "Conversation compacted:\n\n";

export function compactStoredConversation(options: {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly generation: number;
  readonly sessionId: string;
  readonly summary: string;
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
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(condition);
    const userId = requireRunningSessionUserId(transaction, condition);

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
    appendSystemStoredMessage({
      database: transaction,
      generateId: options.generateId,
      message: storedUserMessageValues(
        `${COMPACTION_MESSAGE_PREFIX}${options.summary}`,
      ),
      now: options.now,
      sessionId: options.sessionId,
      userId,
    });
    setSession.run();
  });
}
