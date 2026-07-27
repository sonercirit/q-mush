import { asc, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { runners } from "../shared/database/schema.ts";
import { runnerQuery } from "./runner-registration-query.ts";

const RUNNER_SUMMARY_SELECTION = {
  architecture: runners.architecture,
  id: runners.id,
  isDefault: runners.isDefault,
  isGlobal: runners.isGlobal,
  lastSeenAt: runners.lastSeenAt,
  machineFingerprint: runners.machineFingerprint,
  platform: runners.platform,
  ...{
    name: runners.name,
  },
};

export function orderedRunnerQuery(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
) {
  return runnerQuery(database, RUNNER_SUMMARY_SELECTION, condition).orderBy(
    asc(runners.createdAt),
    asc(runners.id),
  );
}
