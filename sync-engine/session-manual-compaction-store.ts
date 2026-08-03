import { and, eq } from "drizzle-orm";
import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentSessionOperations,
  agentSessions,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { runningCondition } from "./session-store-persistence.ts";

export type ManualCompactionScheduleResult =
  "already_pending" | "scheduled" | "unavailable";

function pendingCondition(sessionId: string, generation: number) {
  return and(
    eq(agentSessionOperations.sessionId, sessionId),
    eq(agentSessionOperations.executionGeneration, generation),
    eq(agentSessionOperations.operation, "compact_and_continue"),
    eq(agentSessionOperations.isDeleted, false),
  );
}

export class ManualCompactionStore {
  readonly #database: AppDatabase;
  readonly #generateId: IdGenerator;

  constructor(database: AppDatabase, generateId: IdGenerator) {
    this.#database = database;
    this.#generateId = generateId;
  }

  pending(sessionId: string, generation: number): boolean {
    return (
      this.#database
        .select({ id: agentSessionOperations.id })
        .from(agentSessionOperations)
        .where(pendingCondition(sessionId, generation))
        .get() !== undefined
    );
  }

  schedule(
    sessionId: string,
    generation: number,
    now: number,
  ): ManualCompactionScheduleResult {
    return this.#database.transaction((transaction) => {
      const running = transaction
        .select({ id: agentSessions.id, userId: agentSessions.userId })
        .from(agentSessions)
        .where(runningCondition(sessionId, undefined, generation))
        .get();
      if (running === undefined) {
        return "unavailable";
      }
      if (
        transaction
          .select({ id: agentSessionOperations.id })
          .from(agentSessionOperations)
          .where(pendingCondition(sessionId, generation))
          .get() !== undefined
      ) {
        return "already_pending";
      }
      transaction
        .insert(agentSessionOperations)
        .values({
          ...createdAuditFields(SYSTEM_ID, now),
          executionGeneration: generation,
          id: this.#generateId(now),
          operation: "compact_and_continue",
          sessionId,
          userId: running.userId,
        })
        .run();
      return "scheduled";
    });
  }
}
