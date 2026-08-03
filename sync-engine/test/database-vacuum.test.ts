import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import { readSqlitePragmaNumber } from "../../shared/test/sqlite.ts";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import {
  enableIncrementalVacuum,
  startIncrementalVacuum,
} from "../database-vacuum.ts";

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-incremental-vacuum-",
);

function fileDatabase(name: string): { database: AppDatabase; path: string } {
  const path = join(temporaryDirectory(), name);
  return { database: createDatabase(path), path };
}

function close(database: AppDatabase): void {
  database.$client.close();
}

function expectEnablement(
  database: AppDatabase,
  actual: ReturnType<typeof enableIncrementalVacuum>,
  expected: ReturnType<typeof enableIncrementalVacuum>,
  mode: number,
): void {
  expect(actual).toEqual(expected);
  expect(readSqlitePragmaNumber(database.$client, "auto_vacuum")).toBe(mode);
  close(database);
}

function expectSkipped(
  fixture: ReturnType<typeof fileDatabase>,
  enabled: ReturnType<typeof enableIncrementalVacuum>,
  messages: readonly string[],
  message: string,
): void {
  expectEnablement(
    fixture.database,
    enabled,
    { enabled: false, rebuilt: false, skipped: true },
    0,
  );
  expect(messages.join(" ")).toContain(message);
}

function warningRecorder(): {
  readonly messages: string[];
  readonly warn: (message: string) => void;
} {
  const messages: string[] = [];
  return { messages, warn: (message) => messages.push(message) };
}

test("enabling incremental vacuum performs the guarded one-time rebuild", () => {
  const fixture = fileDatabase("enable.sqlite");
  const availableBytes = statSync(fixture.path).size * 2;

  const enabled = enableIncrementalVacuum(fixture.database.$client, {
    availableBytes,
  });

  expectEnablement(
    fixture.database,
    enabled,
    { enabled: true, rebuilt: true, skipped: false },
    2,
  );
});

test("low-space preflight skips a small rebuild below the five-GiB floor", () => {
  const fixture = fileDatabase("low-space.sqlite");
  const warning = warningRecorder();
  const availableBytes = 4 * 1024 ** 3;
  const minimumFreeBytes = 5 * 1024 ** 3;
  expect(statSync(fixture.path).size * 2).toBeLessThan(availableBytes);

  const enabled = enableIncrementalVacuum(fixture.database.$client, {
    availableBytes,
    minimumFreeBytes,
    warn: warning.warn,
  });

  expectSkipped(fixture, enabled, warning.messages, String(minimumFreeBytes));
});

test("a rebuild failure is reported and never blocks startup", () => {
  const fixture = fileDatabase("failed.sqlite");
  const messages: string[] = [];
  const availableBytes = statSync(fixture.path).size * 2;
  const fail = () => {
    throw new Error("simulated SQLITE_FULL");
  };

  const enabled = enableIncrementalVacuum(fixture.database.$client, {
    availableBytes,
    run: fail,
    warn: (message) => messages.push(message),
  });

  expectSkipped(fixture, enabled, messages, "simulated SQLITE_FULL");
});

test("converts a FULL auto-vacuum database to incremental mode", () => {
  const fixture = fileDatabase("full.sqlite");
  fixture.database.$client.run("PRAGMA auto_vacuum = FULL");
  fixture.database.$client.run("VACUUM");

  const enabled = enableIncrementalVacuum(fixture.database.$client, {
    availableBytes: 0,
  });

  expectEnablement(
    fixture.database,
    enabled,
    { enabled: true, rebuilt: false, skipped: false },
    2,
  );
});

test("incremental vacuum reclaims pages after synthetic database churn", () => {
  vi.useFakeTimers();
  const fixture = fileDatabase("churn.sqlite");
  fixture.database.$client.run("PRAGMA auto_vacuum = INCREMENTAL");
  fixture.database.$client.run("VACUUM");
  expect(enableIncrementalVacuum(fixture.database.$client).rebuilt).toBe(false);
  fixture.database.$client.run("CREATE TABLE churn (value BLOB NOT NULL)");
  const insert = fixture.database.$client.prepare(
    "INSERT INTO churn VALUES (?)",
  );
  const payload = Buffer.alloc(32 * 1024);
  for (let index = 0; index < 128; index += 1) {
    insert.run(payload);
  }
  const peakBytes = statSync(fixture.path).size;
  fixture.database.$client.run("DELETE FROM churn");
  const freePagesBefore = readSqlitePragmaNumber(
    fixture.database.$client,
    "freelist_count",
  );

  const timer = startIncrementalVacuum(fixture.database.$client);
  vi.advanceTimersByTime(60 * 60_000);
  const freePagesAfter = readSqlitePragmaNumber(
    fixture.database.$client,
    "freelist_count",
  );
  const finalBytes = statSync(fixture.path).size;

  const finalMode = readSqlitePragmaNumber(
    fixture.database.$client,
    "auto_vacuum",
  );
  expect(finalMode).toBe(2);
  expect(freePagesBefore).toBeGreaterThan(0);
  expect(freePagesAfter).toBeLessThan(freePagesBefore);
  expect(finalBytes).toBeLessThan(peakBytes);
  clearInterval(timer);
  vi.useRealTimers();
  close(fixture.database);
});
