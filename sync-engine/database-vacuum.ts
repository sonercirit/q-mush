import type { Database } from "bun:sqlite";

const INCREMENTAL_VACUUM_PAGES = 1_000;
const INCREMENTAL_VACUUM_INTERVAL_MS = 60 * 60_000;

function pragmaNumber(
  database: Database,
  pragma: "auto_vacuum" | "freelist_count",
): number {
  const row: unknown = database.query(`PRAGMA ${pragma}`).get();
  if (typeof row !== "object" || row === null) {
    return 0;
  }
  const value: unknown = Reflect.get(row, pragma);
  return typeof value === "number" ? value : 0;
}

export interface IncrementalVacuumEnablement {
  readonly enabled: boolean;
  readonly rebuilt: boolean;
}

export function enableIncrementalVacuum(
  database: Database,
): IncrementalVacuumEnablement {
  const current = pragmaNumber(database, "auto_vacuum");
  if (current === 2) {
    return { enabled: true, rebuilt: false };
  }
  if (current === 0) {
    database.run("PRAGMA auto_vacuum = INCREMENTAL");
    // Changing auto_vacuum on an existing database requires one rebuild. This
    // runs before the server opens; subsequent live maintenance is incremental.
    database.run("VACUUM");
  }
  return {
    enabled: pragmaNumber(database, "auto_vacuum") === 2,
    rebuilt: current === 0,
  };
}

function runIncrementalVacuum(database: Database): number {
  if (pragmaNumber(database, "auto_vacuum") !== 2) {
    return 0;
  }
  const freePages = pragmaNumber(database, "freelist_count");
  if (freePages === 0) {
    return 0;
  }
  database.run(
    `PRAGMA incremental_vacuum(${String(Math.min(freePages, INCREMENTAL_VACUUM_PAGES))})`,
  );
  return freePages - pragmaNumber(database, "freelist_count");
}

export function startIncrementalVacuum(
  database: Database,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      const reclaimedPages = runIncrementalVacuum(database);
      if (reclaimedPages > 0) {
        console.log(
          `Incremental database vacuum reclaimed ${String(reclaimedPages)} page(s)`,
        );
      }
    } catch (error) {
      console.warn("Incremental database vacuum failed", error);
    }
  }, INCREMENTAL_VACUUM_INTERVAL_MS);
}
