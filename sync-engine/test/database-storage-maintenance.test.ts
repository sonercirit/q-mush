import {
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { readSqlitePragmaNumber } from "../../shared/test/sqlite.ts";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import { checkDatabaseFreeSpace } from "../database-free-space.ts";
import { cleanupRepairSnapshots } from "../database-repair-snapshots.ts";
import { openDatabaseAndCleanupRepairSnapshots } from "../database-storage-maintenance.ts";
import { EngineHealth } from "../engine-health.ts";

const TEST_MINIMUM_FREE_BYTES = 5 * 1024 ** 3;

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-storage-maintenance-",
);

interface MaintenanceFixture {
  readonly databasePath: string;
  readonly directory: string;
}

function maintenanceFixture(): MaintenanceFixture {
  const directory = temporaryDirectory();
  mkdirSync(directory, { recursive: true });
  return { databasePath: join(directory, "q-mush.sqlite"), directory };
}

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
  const { databasePath, directory } = maintenanceFixture();
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

test("repair cleanup always retains the newest snapshot regardless of age", () => {
  const fixture = maintenanceFixture();
  const newest = repairSnapshot(fixture.directory, "old-newest", 30, 1);
  const oldest = repairSnapshot(fixture.directory, "old-oldest", 31, 2);

  const result = cleanupRepairSnapshots(fixture.databasePath, {
    log: vi.fn(),
  });

  expect(result.bytesReclaimed).toBe(2);
  expect(result.removed).toStrictEqual([oldest]);
  expect(statSync(newest).size).toBe(1);
});

test("main database can be opened and validated before snapshot cleanup", () => {
  const fixture = maintenanceFixture();
  const recoveryCopy = repairSnapshot(fixture.directory, "recovery", 30, 4);
  writeFileSync(fixture.databasePath, "not a sqlite database");

  expect(() =>
    openDatabaseAndCleanupRepairSnapshots(fixture.databasePath),
  ).toThrow();

  expect(statSync(recoveryCopy).size).toBe(4);
});

test("quick_check retains every snapshot for corruption outside the schema", () => {
  const fixture = maintenanceFixture();
  const newest = repairSnapshot(fixture.directory, "newest", 1, 1);
  const older = repairSnapshot(fixture.directory, "older", 30, 2);
  const created = createDatabase(fixture.databasePath);
  created.$client.run(
    "CREATE TABLE corruption_fixture (payload BLOB NOT NULL)",
  );
  created.$client.run(
    "INSERT INTO corruption_fixture VALUES (zeroblob(32768))",
  );
  const rootPage = created.$client
    .query(
      "SELECT rootpage FROM sqlite_master WHERE name = 'corruption_fixture'",
    )
    .values()[0]?.[0];
  const pageSize = readSqlitePragmaNumber(created.$client, "page_size");
  created.$client.close();
  if (typeof rootPage !== "number") {
    throw new TypeError("The corruption fixture root page is unavailable");
  }
  const file = openSync(fixture.databasePath, "r+");
  writeSync(file, Buffer.from([0]), 0, 1, (rootPage - 1) * pageSize);
  closeSync(file);
  const warn = vi.fn();
  const health = new EngineHealth(warn);

  const database = openDatabaseAndCleanupRepairSnapshots(fixture.databasePath, {
    health,
  });

  expect(health.snapshot().reasons).toContain("database_corrupt");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("quick_check"),
    expect.objectContaining({ code: "SQLITE_CORRUPT" }),
  );
  expect(statSync(newest).size).toBe(1);
  expect(statSync(older).size).toBe(2);
  database.$client.close();
});

test("low-space preflight degrades and then restores storage health", () => {
  const warn = vi.fn();
  const health = new EngineHealth(warn);
  const databasePath = join(temporaryDirectory(), "q-mush.sqlite");
  const stats = (bytes: number) => () => ({
    bavail: bytes,
    bsize: 1,
  });

  const lowSpace = checkDatabaseFreeSpace(
    databasePath,
    health,
    stats(TEST_MINIMUM_FREE_BYTES - 1),
  );
  expect(lowSpace).toBe(TEST_MINIMUM_FREE_BYTES - 1);
  const degraded = health.snapshot();
  expect(degraded.degraded).toBe(true);
  expect(degraded.reasons).toStrictEqual(["low_disk_space"]);

  const recovered = checkDatabaseFreeSpace(
    databasePath,
    health,
    stats(TEST_MINIMUM_FREE_BYTES),
  );
  expect(recovered).toBe(TEST_MINIMUM_FREE_BYTES);
  expect(health.snapshot().reasons).toStrictEqual([]);
});
