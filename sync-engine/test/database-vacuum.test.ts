import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDatabase } from "../../shared/database.ts";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import {
  enableIncrementalVacuum,
  startIncrementalVacuum,
} from "../database-vacuum.ts";

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-incremental-vacuum-",
);

function pragma(
  database: ReturnType<typeof createDatabase>,
  name: string,
): number {
  const rows: unknown[][] = database.$client.query(`PRAGMA ${name}`).values();
  return typeof rows[0]?.[0] === "number" ? rows[0][0] : 0;
}

test("enabling incremental vacuum performs the required one-time rebuild", () => {
  const path = join(temporaryDirectory(), "enable.sqlite");
  const database = createDatabase(path);

  expect(enableIncrementalVacuum(database.$client).rebuilt).toBe(true);
  expect(pragma(database, "auto_vacuum")).toBe(2);
  database.$client.close();
});

test("incremental vacuum reclaims pages after synthetic database churn", () => {
  vi.useFakeTimers();
  const path = join(temporaryDirectory(), "churn.sqlite");
  const database = createDatabase(path);
  database.$client.run("PRAGMA auto_vacuum = INCREMENTAL");
  database.$client.run("VACUUM");
  expect(enableIncrementalVacuum(database.$client).rebuilt).toBe(false);
  database.$client.run("CREATE TABLE churn (value BLOB NOT NULL)");
  const insert = database.$client.prepare("INSERT INTO churn VALUES (?)");
  const payload = Buffer.alloc(32 * 1024);
  for (let index = 0; index < 128; index += 1) {
    insert.run(payload);
  }
  const peakBytes = statSync(path).size;
  database.$client.run("DELETE FROM churn");
  const freePagesBefore = pragma(database, "freelist_count");

  const timer = startIncrementalVacuum(database.$client);
  vi.advanceTimersByTime(60 * 60_000);
  const freePagesAfter = pragma(database, "freelist_count");
  const finalBytes = statSync(path).size;

  expect(pragma(database, "auto_vacuum")).toBe(2);
  expect(freePagesBefore).toBeGreaterThan(0);
  expect(freePagesAfter).toBeLessThan(freePagesBefore);
  expect(finalBytes).toBeLessThan(peakBytes);
  clearInterval(timer);
  vi.useRealTimers();
  database.$client.close();
});
