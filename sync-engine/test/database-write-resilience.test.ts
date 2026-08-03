import { blob, sqliteTable } from "drizzle-orm/sqlite-core";
import { expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { readSqlitePragmaNumber } from "../../shared/test/sqlite.ts";
import {
  DatabaseWriteResilience,
  installDatabaseWriteResilience,
  isDiskFullFailure,
  runNoncriticalDatabaseWrite,
  startDatabaseRecoveryWatcher,
} from "../database-write-resilience.ts";
import { EngineHealth } from "../engine-health.ts";

const resilienceFixture = sqliteTable("resilience_fixture", {
  payload: blob("payload").notNull(),
});

interface ResilientDatabaseFixture {
  readonly database: AppDatabase;
  readonly health: EngineHealth;
}

function diskFullError(): Error & { readonly code: string } {
  return Object.assign(new Error("database or disk is full"), {
    code: "SQLITE_FULL",
  });
}

function adjustPageLimit(database: AppDatabase, pages: number): void {
  database.$client.run(
    `PRAGMA max_page_count = ${String(readSqlitePragmaNumber(database.$client, "page_count") + pages)}`,
  );
}

function newHealth(): EngineHealth {
  return new EngineHealth(vi.fn());
}

type ResilienceFactory = (
  health: EngineHealth,
  database: AppDatabase,
) => DatabaseWriteResilience;

function resilientDatabase(
  configure?: ResilienceFactory,
): ResilientDatabaseFixture {
  const health = newHealth();
  const database = createDatabase(":memory:");
  database.$client.run(
    "CREATE TABLE resilience_fixture (payload BLOB NOT NULL)",
  );
  installDatabaseWriteResilience(
    database,
    configure?.(health, database) ?? new DatabaseWriteResilience({ health }),
  );
  return { database, health };
}

function setupFullDatabase(
  configure?: ResilienceFactory,
): ResilientDatabaseFixture {
  const fixture = resilientDatabase(configure);
  adjustPageLimit(fixture.database, 1);
  return fixture;
}

function largePayload(): Buffer {
  return Buffer.alloc(1024 * 1024);
}

function insertLargeFixture(database: AppDatabase): void {
  const insert = database.insert(resilienceFixture);
  insert.values({ payload: largePayload() }).run();
}

function fixtureRows(database: AppDatabase) {
  return database.select().from(resilienceFixture).all();
}

function expectDiskFullHealth(health: EngineHealth): void {
  expect(health.snapshot().reasons).toStrictEqual(["disk_full"]);
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("The fixture action did not fail");
}

function recoveringResilience(
  delays: number[],
  health: EngineHealth,
  database: AppDatabase,
): DatabaseWriteResilience {
  return new DatabaseWriteResilience({
    health,
    sleep(delay) {
      delays.push(delay);
      adjustPageLimit(database, 10_000);
    },
  });
}

function recoveryFixture(delays: number[]): ResilientDatabaseFixture {
  return setupFullDatabase((health, database) =>
    recoveringResilience(delays, health, database),
  );
}

test("drops an actual SQLite full-disk write through the Drizzle seam", () => {
  const fixture = setupFullDatabase();

  expect(() => {
    runNoncriticalDatabaseWrite(fixture.database, () => {
      insertLargeFixture(fixture.database);
    });
  }).not.toThrow();

  expect(fixtureRows(fixture.database)).toHaveLength(0);
  expect(fixture.health.snapshot()).toEqual({
    degraded: true,
    reasons: ["disk_full"],
  });
  fixture.database.$client.close();
});

test("keeps mutation all synchronous while retrying an actual SQLite error", () => {
  const delays: number[] = [];
  const fixture = recoveryFixture(delays);

  const rows = fixture.database
    .insert(resilienceFixture)
    .values({ payload: largePayload() })
    .returning()
    .all();

  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(1);
  expect(delays).toStrictEqual([100]);
  expect(fixture.health.snapshot().degraded).toBe(false);
  fixture.database.$client.close();
});

test("keeps a retried Drizzle transaction coupled to its synchronous caller", () => {
  const delays: number[] = [];
  let sqliteError: unknown;
  const fixture = recoveryFixture(delays);

  const result = fixture.database.transaction((transaction) => {
    try {
      transaction
        .insert(resilienceFixture)
        .values({ payload: largePayload() })
        .run();
    } catch (error) {
      sqliteError = error;
      throw new Error("Drizzle transaction write failed", { cause: error });
    }
    return "persisted" as const;
  });

  expect(sqliteError).toMatchObject({
    code: "SQLITE_FULL",
    errno: 13,
    message: "database or disk is full",
  });
  expect(result).toBe("persisted");
  expect(delays).toStrictEqual([100]);
  expect(fixtureRows(fixture.database)).toHaveLength(1);
  fixture.database.$client.close();
});

test("bounds critical retries and throws a typed error to the caller", () => {
  const health = newHealth();
  const delays: number[] = [];
  let attempts = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep(delay) {
      delays.push(delay);
    },
  });

  const write = () => {
    attempts += 1;
    throw diskFullError();
  };
  const execute = () => {
    resilience.run("critical", write);
  };

  expect(isDiskFullFailure(captureError(execute))).toBe(true);

  expect(attempts).toBe(4);
  expect(delays).toStrictEqual([100, 400, 1_500]);
  expectDiskFullHealth(health);
});

test("surfaces a non-disk retry failure synchronously", () => {
  const health = newHealth();
  const changedCondition = new Error("the write precondition changed");
  let attempts = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep: () => undefined,
  });

  const write = () => {
    attempts += 1;
    if (attempts === 1) {
      throw diskFullError();
    }
    throw changedCondition;
  };

  expect(() => {
    resilience.run("critical", write);
  }).toThrow(changedCondition);
  expect(attempts).toBe(2);
  expectDiskFullHealth(health);
});

test("an asynchronous probe clears disk-full health after storage recovers", async () => {
  vi.useFakeTimers();
  const health = newHealth();
  const database = createDatabase(":memory:");
  health.degrade("disk_full", "fixture disk full", diskFullError());
  const timer = startDatabaseRecoveryWatcher(database.$client, health);

  await vi.advanceTimersByTimeAsync(30_000);

  expect(health.snapshot().reasons).toStrictEqual([]);
  clearInterval(timer);
  database.$client.close();
  vi.useRealTimers();
});

test("closed resilience rejects writes before calling them", () => {
  const resilience = new DatabaseWriteResilience({ health: newHealth() });
  const write = vi.fn();

  resilience.close();

  const runClosed = (): void => {
    resilience.run("critical", write);
  };
  expect(runClosed).toThrow("shut down");
  expect(write).not.toHaveBeenCalled();
});
