import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { runnerIsAvailable } from "./runner-availability-store.ts";
import { activeSessionCondition } from "./session-store-persistence.ts";

export function storedSessionRunnerIsAvailable(
  database: Pick<AppDatabase, "select">,
  userId: string,
  sessionId: string,
  now: number,
): boolean {
  const stored = database
    .select({ runnerId: agentSessions.runnerId })
    .from(agentSessions)
    .where(
      and(
        activeSessionCondition({ id: sessionId, userId }),
        eq(agentSessions.runnerRequired, false),
      ),
    )
    .get();
  return (
    stored !== undefined &&
    runnerIsAvailable(database, userId, stored.runnerId, now)
  );
}
