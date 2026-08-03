import { blob, sqliteTable } from "drizzle-orm/sqlite-core";
import { expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { readSqlitePragmaNumber } from "../../shared/test/sqlite.ts";
import {
  DatabaseWriteResilience,
  installDatabaseWriteResilience,
  runNoncriticalDatabaseWrite,
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

function resilientDatabase(
  configure?: (
    health: EngineHealth,
    database: AppDatabase,
  ) => DatabaseWriteResilience,
): ResilientDatabaseFixture {
  const health = new EngineHealth(vi.fn());
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

function insertLargeFixture(database: AppDatabase): void {
  const payload = Buffer.alloc(1024 * 1024);
  database.insert(resilienceFixture).values({ payload }).run();
}

test("drops an actual SQLite full-disk write through the Drizzle seam", () => {
  const fixture = resilientDatabase();
  adjustPageLimit(fixture.database, 1);

  expect(() => {
    runNoncriticalDatabaseWrite(fixture.database, () => {
      insertLargeFixture(fixture.database);
    });
  }).not.toThrow();

  expect(fixture.database.select().from(resilienceFixture).all()).toHaveLength(
    0,
  );
  expect(fixture.health.snapshot()).toEqual({
    degraded: true,
    reasons: ["disk_full"],
  });
  fixture.database.$client.close();
});

test("recognizes Bun's wrapped SQLiteError and returns only after retry lands", () => {
  const delays: number[] = [];
  const fixture = resilientDatabase(
    (health, database) =>
      new DatabaseWriteResilience({
        health,
        sleep: (delay) => {
          delays.push(delay);
          adjustPageLimit(database, 10_000);
        },
      }),
  );
  adjustPageLimit(fixture.database, 1);
  let sqliteError: unknown;

  const result = fixture.database.transaction((transaction) => {
    try {
      const query = transaction.insert(resilienceFixture);
      query.values({ payload: Buffer.alloc(1024 * 1024) }).run();
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
  const rowsAfterRetry = fixture.database
    .select()
    .from(resilienceFixture)
    .all();
  expect(rowsAfterRetry).toHaveLength(1);
  expect(fixture.health.snapshot().degraded).toBe(false);
  fixture.database.$client.close();
});

test("retries one critical write in order with capped backoff", () => {
  const health = new EngineHealth(vi.fn());
  const delays: number[] = [];
  const events: string[] = [];
  let attempts = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep(delay) {
      delays.push(delay);
      expect(health.snapshot().degraded).toBe(true);
    },
  });

  const first = resilience.run("critical", () => {
    attempts += 1;
    events.push(`first-${String(attempts)}`);
    if (attempts < 6) {
      throw diskFullError();
    }
    return "first";
  });
  const second = resilience.run("critical", () => {
    events.push("second");
    return "second";
  });

  expect(first).toBe("first");
  expect(second).toBe("second");
  expect(delays).toStrictEqual([100, 500, 2_000, 5_000, 5_000]);
  expect(events).toStrictEqual([
    "first-1",
    "first-2",
    "first-3",
    "first-4",
    "first-5",
    "first-6",
    "second",
  ]);
  expect(health.snapshot().degraded).toBe(false);
});

test("rejects retry-queue overflow without retaining or applying the write", () => {
  const health = new EngineHealth(vi.fn());
  let available = false;
  let overflow: unknown;
  let overflowWrites = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep: () => {
      try {
        resilience.run("critical", () => {
          overflowWrites += 1;
        });
      } catch (error) {
        overflow = error;
      }
      expect(health.snapshot().reasons).toContain("disk_full");
      available = true;
    },
  });

  resilience.run("critical", () => {
    if (!available) {
      throw diskFullError();
    }
  });

  expect(overflow).toBeInstanceOf(Error);
  if (!(overflow instanceof Error)) {
    throw new Error("The retry queue did not surface an Error");
  }
  expect(overflow.message).toContain("retry queue is full");
  expect(overflowWrites).toBe(0);
  expect(health.snapshot()).toEqual({ degraded: false, reasons: [] });
});

test("surfaces a non-disk retry failure to the waiting caller", () => {
  const health = new EngineHealth(vi.fn());
  const changedCondition = new Error("the write precondition changed");
  let attempts = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep: vi.fn(),
  });

  expect(() => {
    resilience.run("critical", () => {
      attempts += 1;
      if (attempts === 1) {
        throw diskFullError();
      }
      throw changedCondition;
    });
  }).toThrow(changedCondition);

  expect(attempts).toBe(2);
  expect(health.snapshot().reasons).toHaveLength(0);
});

test("shutdown cancels the active retry before another write attempt", () => {
  const health = new EngineHealth(vi.fn());
  let attempts = 0;
  const resilience = new DatabaseWriteResilience({
    health,
    sleep: () => {
      resilience.close();
    },
  });
  const write = () => {
    attempts += 1;
    throw diskFullError();
  };

  const firstAttempt = () => {
    resilience.run("critical", write);
  };
  expect(firstAttempt).toThrow("shut down");
  expect(attempts).toBe(1);
  expect(() => {
    resilience.run("critical", write);
  }).toThrow("shut down");
  expect(attempts).toBe(1);
});
