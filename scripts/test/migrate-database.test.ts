import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import * as fileSystem from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/database.ts";
import { sessions, users } from "../../src/database/schema.ts";
import { SYSTEM_ID } from "../../src/ids.ts";

const ROOT_DIRECTORY = join(import.meta.dir, "../..");
const INITIAL_MIGRATION_PATH = join(
  ROOT_DIRECTORY,
  "drizzle/0000_whole_paibok.sql",
);
const INITIAL_MIGRATION_TIMESTAMP = 1_784_476_796_446;
const SESSION_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const UUID_V7_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
let temporaryDirectory: string | undefined;

setDefaultTimeout(15_000);

afterEach(() => {
  if (temporaryDirectory !== undefined) {
    fileSystem.rmSync(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = undefined;
  }
});

async function runMigrationCommand(databasePath: string): Promise<void> {
  const migrationProcess = Bun.spawn(["bun", "run", "db:migrate"], {
    cwd: ROOT_DIRECTORY,
    env: { ...process.env, DATABASE_PATH: databasePath },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, standardError, standardOutput] = await Promise.all([
    migrationProcess.exited,
    new Response(migrationProcess.stderr).text(),
    new Response(migrationProcess.stdout).text(),
  ]);

  expect(standardError).not.toContain("error:");
  expect(standardOutput).toContain("Database migrations applied to");
  expect(exitCode).toBe(0);
}

async function applyInitialMigration(database: Database): Promise<void> {
  const migration = await Bun.file(INITIAL_MIGRATION_PATH).text();

  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();

    if (sql.length > 0) {
      database.run(sql);
    }
  }

  database.run(`
    CREATE TABLE __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  database.run(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ["initial", INITIAL_MIGRATION_TIMESTAMP],
  );
}

test("database migration command applies pending migrations", async () => {
  temporaryDirectory = fileSystem.mkdtempSync(
    join(tmpdir(), "q-mush-migrate-test-"),
  );
  const databasePath = join(temporaryDirectory, "migrated.sqlite");
  await runMigrationCommand(databasePath);

  const database = new Database(databasePath, { readonly: true });
  const tables = database
    .query<{ readonly name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  database.close();

  expect(tables).toContain("sessions");
  expect(tables).toContain("users");
});

test("migration preserves records created by the initial schema", async () => {
  temporaryDirectory = fileSystem.mkdtempSync(
    join(tmpdir(), "q-mush-upgrade-test-"),
  );
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  const legacyDatabase = new Database(databasePath, { create: true });
  await applyInitialMigration(legacyDatabase);

  const legacyExpiry = 1_800_000_000_000;
  legacyDatabase.run(
    "INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)",
    ["legacy-google-subject", "legacy@example.com", "Legacy User", null],
  );
  legacyDatabase.run(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
    ["legacy-session-token", "legacy-google-subject", legacyExpiry],
  );
  legacyDatabase.close();

  const migrationStartedAt = Date.now();
  await runMigrationCommand(databasePath);

  const migratedDatabase = createDatabase(databasePath);
  const migratedUser = migratedDatabase.select().from(users).get();
  const migratedSession = migratedDatabase.select().from(sessions).get();

  if (migratedUser === undefined || migratedSession === undefined) {
    throw new Error("The legacy records were not preserved");
  }

  expect(migratedUser).toEqual({
    createdAt: new Date(legacyExpiry - SESSION_LIFETIME_MILLISECONDS),
    createdById: SYSTEM_ID,
    email: "legacy@example.com",
    googleSubject: "legacy-google-subject",
    id: migratedUser.id,
    isDeleted: false,
    name: "Legacy User",
    picture: null,
    updatedAt: migratedUser.updatedAt,
    updatedById: SYSTEM_ID,
  });
  expect(migratedUser.id).toMatch(UUID_V7_PATTERN);
  expect(migratedUser.updatedAt.getTime()).toBeGreaterThanOrEqual(
    migrationStartedAt,
  );
  expect(migratedSession).toEqual({
    createdAt: new Date(legacyExpiry - SESSION_LIFETIME_MILLISECONDS),
    createdById: migratedUser.id,
    expiresAt: new Date(legacyExpiry),
    id: migratedSession.id,
    isDeleted: false,
    token: "legacy-session-token",
    updatedAt: migratedSession.updatedAt,
    updatedById: SYSTEM_ID,
    userId: migratedUser.id,
  });
  expect(migratedSession.id).toMatch(UUID_V7_PATTERN);
  expect(migratedSession.updatedAt.getTime()).toBeGreaterThanOrEqual(
    migrationStartedAt,
  );
  expect(migratedDatabase.select().from(users).all()).toHaveLength(1);
  expect(migratedDatabase.select().from(sessions).all()).toHaveLength(1);

  migratedDatabase.$client.close();
});
