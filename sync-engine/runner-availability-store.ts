import { and, eq, gte, isNotNull, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { runners } from "../shared/database/schema.ts";
import { RUNNER_ONLINE_WINDOW_MILLISECONDS } from "../shared/runner-model.ts";

type RunnerAvailabilityDatabase = Pick<AppDatabase, "select">;

function availableRunnerCondition(
  userId: string,
  runnerId: string,
  now: number,
): SQL | undefined {
  return and(
    eq(runners.id, runnerId),
    eq(runners.userId, userId),
    eq(runners.isDeleted, false),
    isNotNull(runners.machineFingerprint),
    isNotNull(runners.lastSeenAt),
    gte(runners.lastSeenAt, new Date(now - RUNNER_ONLINE_WINDOW_MILLISECONDS)),
  );
}

export function runnerIsAvailable(
  database: RunnerAvailabilityDatabase,
  userId: string,
  runnerId: string,
  now: number,
): boolean {
  return (
    database
      .select({ lastSeenAt: runners.lastSeenAt })
      .from(runners)
      .where(availableRunnerCondition(userId, runnerId, now))
      .get()?.lastSeenAt !== undefined
  );
}
