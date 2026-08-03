import type { Database } from "bun:sqlite";

const INCREMENTAL_VACUUM_PAGES = 1_000;
const INCREMENTAL_VACUUM_INTERVAL_MS = 60 * 60_000;

function pragmaNumber(
  database: Database,
  pragma: "auto_vacuum" | "freelist_count" | "page_count" | "page_size",
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
  readonly skipped: boolean;
}

interface IncrementalVacuumOptions {
  readonly availableBytes?: number | undefined;
  readonly minimumFreeBytes?: number | undefined;
  readonly run?: (sql: string) => void;
  readonly warn?: (message: string) => void;
}

function databaseBytes(database: Database): number {
  return (
    pragmaNumber(database, "page_count") * pragmaNumber(database, "page_size")
  );
}

export function databaseVacuumSafetyBytes(database: Database): number {
  return pragmaNumber(database, "auto_vacuum") === 0
    ? databaseBytes(database) * 2
    : 0;
}

function skipped(): IncrementalVacuumEnablement {
  return { enabled: false, rebuilt: false, skipped: true };
}

function warnAndSkip(
  warn: (message: string) => void,
  message: string,
): IncrementalVacuumEnablement {
  warn(message);
  return skipped();
}

function failureMessage(
  operation: "mode conversion" | "rebuild",
  error: unknown,
) {
  return `Skipping incremental-vacuum ${operation} after it failed: ${String(error)}`;
}

function result(
  database: Database,
  rebuilt: boolean,
): IncrementalVacuumEnablement {
  return {
    enabled: pragmaNumber(database, "auto_vacuum") === 2,
    rebuilt,
    skipped: false,
  };
}

export function enableIncrementalVacuum(
  database: Database,
  options: IncrementalVacuumOptions = {},
): IncrementalVacuumEnablement {
  const current = pragmaNumber(database, "auto_vacuum");
  if (current === 2) {
    return { enabled: true, rebuilt: false, skipped: false };
  }
  const run = options.run ?? database.run.bind(database);
  const warn = options.warn ?? console.warn;
  if (current === 1) {
    // FULL and INCREMENTAL use the same pointer-map format, so this mode change
    // needs no rebuild and immediately enables bounded incremental maintenance.
    try {
      run("PRAGMA auto_vacuum = INCREMENTAL");
    } catch (error) {
      return warnAndSkip(warn, failureMessage("mode conversion", error));
    }
    return result(database, false);
  }
  const requiredBytes = Math.max(
    databaseBytes(database) * 2,
    options.minimumFreeBytes ?? 0,
  );
  if (
    options.availableBytes !== undefined &&
    options.availableBytes < requiredBytes
  ) {
    return warnAndSkip(
      warn,
      `Skipping incremental-vacuum rebuild: ${String(options.availableBytes)} free bytes is below the ${String(requiredBytes)}-byte safety margin`,
    );
  }
  try {
    run("PRAGMA auto_vacuum = INCREMENTAL");
    // SQLite documents that VACUUM copies into a temporary database before
    // overwriting the original under a rollback journal or WAL transaction.
    // Interruption may leave temporary/journal files, but it does not turn this
    // failed startup optimization into a partial replacement database.
    run("VACUUM");
  } catch (error) {
    return warnAndSkip(warn, failureMessage("rebuild", error));
  }
  return result(database, true);
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
