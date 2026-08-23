import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessionOperations,
  agentSessions,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { manualCompactionOperation } from "./session-manual-compaction-query.ts";
import { runningCondition } from "./session-store-persistence.ts";

type ManualCompactionScheduleResult =
  "already_pending" | "scheduled" | "unavailable";

export interface ManualCompactionStore {
  readonly pending: (sessionId: string, generation: number) => boolean;
  readonly schedule: (
    sessionId: string,
    generation: number,
    now: number,
  ) => ManualCompactionScheduleResult;
}

export function createManualCompactionStore(
  database: AppDatabase,
  id: IdGenerator,
): ManualCompactionStore {
  return {
    pending: (sessionId, generation) =>
      manualCompactionOperation(database, sessionId, generation) !== undefined,
    schedule: (sessionId, generation, now) =>
      database.transaction((transaction) => {
        const current = transaction
          .select({ userId: agentSessions.userId })
          .from(agentSessions)
          .where(runningCondition(sessionId, undefined, generation))
          .get();
        if (current === undefined) {
          return "unavailable";
        }
        if (
          manualCompactionOperation(transaction, sessionId, generation) !==
          undefined
        ) {
          return "already_pending";
        }
        transaction
          .insert(agentSessionOperations)
          .values({
            ...createdAuditFields(SYSTEM_ID, now),
            executionGeneration: generation,
            id: id(now),
            operation: "compact_and_continue",
            sessionId,
            userId: current.userId,
          })
          .run();
        return "scheduled";
      }),
  };
}
