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
  const sessions = readStoredSessionSnapshots(
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
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const depth = (session: StoredSessionSnapshot): number => {
    let current = session;
    let result = 0;
    const visited = new Set<string>();
    while (current.parentSessionId !== null) {
      if (visited.has(current.id)) throw new Error("Session lineage is cyclic");
      visited.add(current.id);
      const parent = byId.get(current.parentSessionId);
      if (parent === undefined) break;
      result += 1;
      current = parent;
    }
    return result;
  };
  return sessions.toSorted((left, right) => depth(right) - depth(left));
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
    const current = readStoredSessionSnapshots(
      database,
      and(
        storedSessionCondition({ id: session.id, userId }),
        eq(agentSessions.runnerId, runnerId),
      ),
    )[0];
    const result =
      current === undefined
        ? undefined
        : fenceAssignedSession(
            database,
            current,
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
