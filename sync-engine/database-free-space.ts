import type { StatsFs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EngineHealth } from "./engine-health.ts";

export type FreeSpaceReader = (
  path: string,
) => Pick<StatsFs, "bavail" | "bsize">;

const MINIMUM_FREE_DATABASE_BYTES = 5 * 1024 ** 3;

export function checkDatabaseFreeSpace(
  databasePath: string,
  health: EngineHealth,
  readStats: FreeSpaceReader,
): number | undefined {
  if (databasePath === ":memory:") {
    health.restore("low_disk_space");
    return undefined;
  }
  const stats = readStats(dirname(resolve(databasePath)));
  const free = stats.bavail * stats.bsize;
  if (free < MINIMUM_FREE_DATABASE_BYTES) {
    health.degrade(
      "low_disk_space",
      `the database volume has only ${String(free)} free bytes; at least ${String(MINIMUM_FREE_DATABASE_BYTES)} are required`,
    );
  } else {
    health.restore("low_disk_space");
  }
  return free;
}
