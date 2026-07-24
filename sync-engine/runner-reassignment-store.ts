import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import {
  SESSION_TIMING_SELECTION,
  transitionSessionRunner,
  type StoredSessionTiming,
} from "./session-store-reassignment.ts";

interface RunnerAssignedSession extends StoredSessionTiming {
  readonly id: string;
}

function affectedRunnerSessions(
  database: Pick<AppDatabase, "select">,
  userId: string,
  runnerId: string,
): readonly RunnerAssignedSession[] {
  const condition = and(
    eq(agentSessions.isDeleted, false),
    eq(agentSessions.userId, userId),
    eq(agentSessions.runnerId, runnerId),
    inArray(agentSessions.status, ["queued", "running", "idle", "failed"]),
  );
  return database
    .select({
      ...SESSION_TIMING_SELECTION,
      id: agentSessions.id,
    })
    .from(agentSessions)
    .where(condition)
    .all();
}

export function requireRunnerReassignment(
  database: Pick<AppDatabase, "select" | "update">,
  userId: string,
  runnerId: string,
  now: number,
): void {
  const affected = affectedRunnerSessions(database, userId, runnerId);
  for (const session of affected) {
    transitionSessionRunner(database, session, now);
  }
}
