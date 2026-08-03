import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DATABASE_STORAGE_POLICY = {
  repairSnapshotRetentionCount: 2,
  repairSnapshotRetentionDays: 14,
} as const;
const REPAIR_SNAPSHOT_MARKER = ".before-";

interface RepairSnapshot {
  readonly modifiedAt: number;
  readonly path: string;
  readonly size: number;
}

export interface RepairSnapshotCleanupOptions {
  readonly log?: (message: string) => void;
  readonly now?: number;
}

export interface RepairSnapshotCleanupResult {
  readonly bytesReclaimed: number;
  readonly removed: readonly string[];
}

function matchingRepairSnapshots(databasePath: string): RepairSnapshot[] {
  const absolutePath = resolve(databasePath);
  const directory = dirname(absolutePath);
  if (!existsSync(directory)) {
    return [];
  }
  const prefix = `${basename(absolutePath)}${REPAIR_SNAPSHOT_MARKER}`;
  return readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const path = join(directory, entry);
      const stats = statSync(path);
      return { modifiedAt: stats.mtimeMs, path, size: stats.size };
    })
    .filter(({ path }) => statSync(path).isFile())
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

export function cleanupRepairSnapshots(
  databasePath: string,
  options: RepairSnapshotCleanupOptions = {},
): RepairSnapshotCleanupResult {
  if (databasePath === ":memory:") {
    return { bytesReclaimed: 0, removed: [] };
  }
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now();
  const maximumAge =
    DATABASE_STORAGE_POLICY.repairSnapshotRetentionDays * 24 * 60 * 60_000;
  const snapshots = matchingRepairSnapshots(databasePath);
  const removed: string[] = [];
  let bytesReclaimed = 0;
  for (const [index, snapshot] of snapshots.entries()) {
    if (
      index === 0 ||
      (index < DATABASE_STORAGE_POLICY.repairSnapshotRetentionCount &&
        now - snapshot.modifiedAt <= maximumAge)
    ) {
      continue;
    }
    unlinkSync(snapshot.path);
    removed.push(snapshot.path);
    bytesReclaimed += snapshot.size;
    log(
      `Removed expired database repair snapshot ${snapshot.path} (${String(snapshot.size)} bytes)`,
    );
  }
  if (removed.length > 0) {
    log(
      `Database repair snapshot cleanup reclaimed ${String(bytesReclaimed)} bytes from ${String(removed.length)} file(s)`,
    );
  }
  return { bytesReclaimed, removed };
}
