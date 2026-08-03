import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessionOperations,
  agentSessions,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { manualCompactionOperation } from "./session-manual-compaction-query.ts";
import { runningCondition } from "./session-store-persistence.ts";

export type ManualCompactionScheduleResult =
  "already_pending" | "scheduled" | "unavailable";

export class ManualCompactionStore {
  readonly #database: AppDatabase;
  readonly #id: IdGenerator;
  constructor(database: AppDatabase, id: IdGenerator) {
    this.#database = database;
    this.#id = id;
  }

  pending(sessionId: string, generation: number): boolean {
    return (
      manualCompactionOperation(this.#database, sessionId, generation) !==
      undefined
    );
  }

  schedule(
    sessionId: string,
    generation: number,
    now: number,
  ): ManualCompactionScheduleResult {
    return this.#database.transaction((transaction) => {
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
          id: this.#id(now),
          operation: "compact_and_continue",
          sessionId,
          userId: current.userId,
        })
        .run();
      return "scheduled";
    });
  }
}
