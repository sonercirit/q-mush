import { and, eq, lte } from "drizzle-orm";
import { softDeletedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessionOperations } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";

function activeManualCompactionCondition(
  sessionId: string,
  generation?: number,
) {
  return and(
    eq(agentSessionOperations.sessionId, sessionId),
    generation === undefined
      ? undefined
      : eq(agentSessionOperations.executionGeneration, generation),
    eq(agentSessionOperations.operation, "compact_and_continue"),
    eq(agentSessionOperations.isDeleted, false),
  );
}

export function retireManualCompactionOperation(
  database: Pick<AppDatabase, "update">,
  sessionId: string,
  generation: number,
  now: number,
): void {
  database
    .update(agentSessionOperations)
    .set(softDeletedAuditFields(SYSTEM_ID, now))
    .where(activeManualCompactionCondition(sessionId, generation))
    .run();
}

export function retireAbandonedManualCompactionOperations(
  database: Pick<AppDatabase, "update">,
  sessionId: string,
  generation: number,
  now: number,
): void {
  database
    .update(agentSessionOperations)
    .set(softDeletedAuditFields(SYSTEM_ID, now))
    .where(
      and(
        activeManualCompactionCondition(sessionId),
        lte(agentSessionOperations.executionGeneration, generation),
      ),
    )
    .run();
}

export function manualCompactionOperation(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  generation?: number,
) {
  return database
    .select({ id: agentSessionOperations.id })
    .from(agentSessionOperations)
    .where(activeManualCompactionCondition(sessionId, generation))
    .get();
}
