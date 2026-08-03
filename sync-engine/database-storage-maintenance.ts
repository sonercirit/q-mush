import { statfsSync } from "node:fs";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import {
  checkDatabaseFreeSpace,
  MINIMUM_FREE_DATABASE_BYTES,
} from "./database-free-space.ts";
import { cleanupRepairSnapshots } from "./database-repair-snapshots.ts";
import type { EngineHealth } from "./engine-health.ts";

const DISK_PREFLIGHT_INTERVAL_MS = 60_000;

export interface DatabaseFreeSpaceMonitor {
  readonly availableBytes: number | undefined;
  readonly timer: ReturnType<typeof setInterval> | undefined;
}

export function openDatabaseAndCleanupRepairSnapshots(
  databasePath: string,
): AppDatabase {
  // Opening applies migrations and validates SQLite before any recovery copy is
  // removed. If this throws, every repair snapshot remains untouched.
  const database = createDatabase(databasePath);
  cleanupRepairSnapshots(databasePath);
  return database;
}

export function startDatabaseFreeSpaceMonitor(
  databasePath: string,
  health: EngineHealth,
  vacuumSafetyBytes = 0,
): DatabaseFreeSpaceMonitor {
  const minimumFreeBytes = Math.max(
    MINIMUM_FREE_DATABASE_BYTES,
    vacuumSafetyBytes,
  );
  const availableBytes = checkDatabaseFreeSpace(
    databasePath,
    health,
    statfsSync,
    minimumFreeBytes,
  );
  if (databasePath === ":memory:") {
    return { availableBytes, timer: undefined };
  }
  return {
    availableBytes,
    timer: setInterval(() => {
      try {
        checkDatabaseFreeSpace(
          databasePath,
          health,
          statfsSync,
          minimumFreeBytes,
        );
      } catch (error) {
        console.warn("Database free-space preflight failed", error);
      }
    }, DISK_PREFLIGHT_INTERVAL_MS),
  };
}
