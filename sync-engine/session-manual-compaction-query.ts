import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessionOperations } from "../shared/database/schema.ts";

export function manualCompactionOperation(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  generation?: number,
) {
  const exactGeneration =
    generation === undefined
      ? undefined
      : eq(agentSessionOperations.executionGeneration, generation);
  return database
    .select({ id: agentSessionOperations.id })
    .from(agentSessionOperations)
    .where(
      and(
        eq(agentSessionOperations.sessionId, sessionId),
        exactGeneration,
        eq(agentSessionOperations.operation, "compact_and_continue"),
        eq(agentSessionOperations.isDeleted, false),
      ),
    )
    .get();
}
