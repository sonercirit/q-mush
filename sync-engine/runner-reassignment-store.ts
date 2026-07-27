import { and, eq, sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import {
  readStoredSessionSnapshots,
  sessionTimingUpdate,
  storedSessionCondition,
  storedSessionSnapshotCondition,
  updateStoredSessions,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";

type RunnerReassignmentDatabase = Pick<AppDatabase, "select" | "update">;

function affectedRunnerSessions(
  database: Pick<AppDatabase, "select">,
  userId: string,
  runnerId: string,
): readonly StoredSessionSnapshot[] {
  return readStoredSessionSnapshots(
    database,
    and(
      storedSessionCondition({
        status: ["paused", "queued", "running", "idle", "stopped", "failed"],
        userId,
      }),
      eq(agentSessions.runnerId, runnerId),
    ),
  );
}

function fenceAssignedSession(
  database: Pick<AppDatabase, "update">,
  session: StoredSessionSnapshot,
  userId: string,
  runnerId: string,
  now: number,
): boolean {
  if (session.userId !== userId) {
    throw new Error("An assigned session has the wrong owner");
  }
  return updateStoredSessions(
    database,
    and(
      storedSessionSnapshotCondition(session),
      eq(agentSessions.runnerId, runnerId),
    ),
    {
      ...sessionTimingUpdate(session, now),
      executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
      restartHandoff: null,
      runnerRequired: true,
      status: session.status === "stopped" ? "stopped" : "idle",
      ...updatedAuditFields(SYSTEM_ID, now),
    },
  );
}

export function requireRunnerReassignment(
  database: RunnerReassignmentDatabase,
  userId: string,
  runnerId: string,
  now: number,
): void {
  const affected = affectedRunnerSessions(database, userId, runnerId);
  for (const session of affected) {
    if (!fenceAssignedSession(database, session, userId, runnerId, now)) {
      throw new Error("An assigned session changed during runner removal");
    }
  }
}
