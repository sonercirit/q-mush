import { and, eq } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import { advanceStoredSessionGeneration } from "./session-generation-advance.ts";
import {
  readStoredSessionSnapshots,
  sessionTimingUpdate,
  storedSessionCondition,
  storedSessionSnapshotCondition,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";

interface RunnerReassignmentResult {
  readonly report?: NonNullable<
    NonNullable<
      ReturnType<typeof advanceStoredSessionGeneration>
    >["reportedParent"]
  >;
  readonly userId: string;
}

type RunnerReassignmentDatabase = Pick<
  AppDatabase,
  "insert" | "select" | "update"
>;

function affectedRunnerSessions(
  database: Pick<AppDatabase, "select">,
  userId: string,
  runnerId: string,
): readonly StoredSessionSnapshot[] {
  return readStoredSessionSnapshots(
    database,
    and(
      storedSessionCondition({
        status: [
          "paused",
          "queued",
          "running",
          "idle",
          "completed",
          "stopped",
          "failed",
        ],
        userId,
      }),
      eq(agentSessions.runnerId, runnerId),
    ),
  );
}

function fenceAssignedSession(
  database: RunnerReassignmentDatabase,
  session: StoredSessionSnapshot,
  userId: string,
  runnerId: string,
  generateId: IdGenerator,
  now: number,
): RunnerReassignmentResult | undefined {
  if (session.userId !== userId) {
    throw new Error("An assigned session has the wrong owner");
  }
  const advanced = advanceStoredSessionGeneration({
    condition: and(
      storedSessionSnapshotCondition(session),
      eq(agentSessions.runnerId, runnerId),
    ),
    database,
    generateId,
    mode: "administrative",
    now,
    sessionId: session.id,
    values: {
      ...sessionTimingUpdate(session, now),
      interruptedHandoff: null,
      restartHandoff: null,
      runnerRequired: true,
      status:
        session.status === "stopped"
          ? "stopped"
          : session.status === "completed"
            ? "completed"
            : "idle",
      ...updatedAuditFields(SYSTEM_ID, now),
    },
  });
  return advanced === undefined
    ? undefined
    : {
        ...(advanced.reportedParent === undefined
          ? {}
          : { report: advanced.reportedParent }),
        userId,
      };
}

export function requireRunnerReassignment(
  database: RunnerReassignmentDatabase,
  userId: string,
  runnerId: string,
  generateId: IdGenerator,
  now: number,
): readonly Required<RunnerReassignmentResult>[] {
  const affected = affectedRunnerSessions(database, userId, runnerId);
  const reports: Required<RunnerReassignmentResult>[] = [];
  for (const session of affected) {
    const result = fenceAssignedSession(
      database,
      session,
      userId,
      runnerId,
      generateId,
      now,
    );
    if (result === undefined) {
      throw new Error("An assigned session changed during runner removal");
    }
    if (result.report !== undefined) {
      reports.push({ report: result.report, userId: result.userId });
    }
  }
  return reports;
}
