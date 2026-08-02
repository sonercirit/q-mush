import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import { checkDatabaseFreeSpace } from "../database-free-space.ts";
import { cleanupRepairSnapshots } from "../database-storage-maintenance.ts";
import { EngineHealth } from "../engine-health.ts";

const TEST_MINIMUM_FREE_BYTES = 5 * 1024 ** 3;

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-storage-maintenance-",
);

function repairSnapshot(
  directory: string,
  name: string,
  ageDays: number,
  bytes: number,
): string {
  const path = join(directory, `q-mush.sqlite.before-${name}`);
  writeFileSync(path, Buffer.alloc(bytes));
  const modifiedAt = new Date(Date.now() - ageDays * 24 * 60 * 60_000);
  utimesSync(path, modifiedAt, modifiedAt);
  return path;
}

test("repair cleanup retains two young snapshots and removes the rest", () => {
  const directory = temporaryDirectory();
  mkdirSync(directory, { recursive: true });
  const databasePath = join(directory, "q-mush.sqlite");
  const newest = repairSnapshot(directory, "newest", 1, 1);
  const second = repairSnapshot(directory, "second", 2, 2);
  const surplus = repairSnapshot(directory, "surplus", 3, 3);
  const expired = repairSnapshot(directory, "expired", 15, 4);
  const log = vi.fn();

  const result = cleanupRepairSnapshots(databasePath, { log });

  expect(result).toEqual({ bytesReclaimed: 7, removed: [surplus, expired] });
  expect(statSync(newest).size).toBe(1);
  expect(statSync(second).size).toBe(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("7 bytes"));
});

test("low-space preflight degrades and then restores storage health", () => {
  const warn = vi.fn();
  const health = new EngineHealth(warn);
  const directory = temporaryDirectory();
  const databasePath = join(directory, "q-mush.sqlite");
  const stats = (bytes: number) => () => ({
    bavail: bytes,
    bsize: 1,
  });

  expect(
    checkDatabaseFreeSpace(
      databasePath,
      health,
      stats(TEST_MINIMUM_FREE_BYTES - 1),
    ),
  ).toBe(TEST_MINIMUM_FREE_BYTES - 1);
  const degraded = health.snapshot();
  expect(degraded.degraded).toBe(true);
  expect(degraded.reasons).toStrictEqual(["low_disk_space"]);

  checkDatabaseFreeSpace(databasePath, health, stats(TEST_MINIMUM_FREE_BYTES));
  expect(health.snapshot().reasons).toHaveLength(0);
});
