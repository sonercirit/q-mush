import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

export function touchStoredSession(
  database: Pick<AppDatabase, "update">,
  condition: SQL | undefined,
  actorId: string,
  now: number,
): void {
  database
    .update(agentSessions)
    .set({ updatedAt: new Date(now), updatedById: actorId })
    .where(condition)
    .run();
}
