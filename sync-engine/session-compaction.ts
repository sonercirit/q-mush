import { and, eq } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { runningCondition } from "./session-store-reassignment.ts";

const COMPACTION_MESSAGE_PREFIX = "Conversation compacted:\n\n";

export function compactStoredConversation(options: {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly generation?: number;
  readonly sessionId: string;
  readonly summary: string;
}): void {
  options.database.transaction((transaction) => {
    const setSession = transaction
      .update(agentSessions)
      .set({
        currentContextTokens: 0,
        ...updatedAuditFields(SYSTEM_ID, options.now),
      })
      .where(
        runningCondition(options.sessionId, undefined, options.generation),
      );
    const session = transaction
      .select({ status: agentSessions.status, userId: agentSessions.userId })
      .from(agentSessions)
      .where(runningCondition(options.sessionId, undefined, options.generation))
      .get();

    if (session?.status !== "running") {
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
          eq(agentMessages.isDeleted, false),
        ),
      )
      .run();
    transaction
      .insert(agentMessages)
      .values({
        ...createdAuditFields(SYSTEM_ID, options.now),
        content: `${COMPACTION_MESSAGE_PREFIX}${options.summary}`,
        id: options.generateId(options.now),
        role: "user",
        sessionId: options.sessionId,
        userId: session.userId,
      })
      .run();
    setSession.run();
  });
}
