import { and, eq } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "./audit.ts";
import type { AppDatabase } from "./database.ts";
import { agentMessages, agentSessions } from "./database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "./ids.ts";

const COMPACTION_MESSAGE_PREFIX = "Conversation compacted:\n\n";

export function compactStoredConversation(options: {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
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
      .where(eq(agentSessions.id, options.sessionId));
    const session = transaction
      .select({ status: agentSessions.status, userId: agentSessions.userId })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, options.sessionId),
          eq(agentSessions.isDeleted, false),
        ),
      )
      .get();

    if (session?.status !== "running") {
      throw new Error("The running agent session no longer exists");
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
