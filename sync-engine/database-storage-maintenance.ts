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
  readonly minimumFreeBytes: number;
  readonly timer: ReturnType<typeof setInterval> | undefined;
}

export interface DatabaseOpenOptions {
  readonly health?: EngineHealth;
}

function quickCheckPassed(database: AppDatabase): boolean {
  // quick_check visits every database page without the slower UNIQUE and index
  // consistency work of integrity_check, making it the startup-safe corruption
  // gate before recovery snapshots are removed.
  const rows: unknown[][] = database.$client
    .query("PRAGMA quick_check")
    .values();
  return rows.length === 1 && rows[0]?.[0] === "ok";
}

export function openDatabaseAndCleanupRepairSnapshots(
  databasePath: string,
  options: DatabaseOpenOptions = {},
): AppDatabase {
  // Opening applies migrations before the cheap whole-file quick_check. If
  // either step fails, every repair snapshot remains untouched.
  const database = createDatabase(databasePath);
  try {
    if (!quickCheckPassed(database)) {
      options.health?.degrade(
        "database_corrupt",
        "PRAGMA quick_check failed; all database repair snapshots were retained",
      );
      return database;
    }
  } catch (error) {
    options.health?.degrade(
      "database_corrupt",
      "PRAGMA quick_check could not validate the database; all database repair snapshots were retained",
      error,
    );
    return database;
  }
  options.health?.restore("database_corrupt");
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
    return { availableBytes, minimumFreeBytes, timer: undefined };
  }
  return {
    availableBytes,
    minimumFreeBytes,
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
