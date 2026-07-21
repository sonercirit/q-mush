import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/database.ts";
import {
  providerCredentials,
  sessions,
  users,
} from "../../src/database/schema.ts";
import { SYSTEM_ID } from "../../src/ids.ts";

const ROOT_DIRECTORY = join(import.meta.dir, "../..");
const MIGRATIONS = [
  { file: "0000_whole_paibok.sql", timestamp: 1_784_476_796_446 },
  { file: "0001_audited-identifiers.sql", timestamp: 1_784_478_537_706 },
  { file: "0002_swift_micromacro.sql", timestamp: 1_784_484_507_050 },
] as const;
const SESSION_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const UUID_V7_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
let temporaryDirectory: string | undefined;

setDefaultTimeout(15_000);

afterEach(() => {
  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
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

async function applyMigrationFile(
  database: Database,
  file: string,
): Promise<void> {
  const migration = await Bun.file(
    join(ROOT_DIRECTORY, "drizzle", file),
  ).text();

  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();

    if (sql.length > 0) {
      database.run(sql);
    }
  }
}

function createMigrationJournal(
  database: Database,
  migrations: readonly { readonly file: string; readonly timestamp: number }[],
): void {
  database.run(`
    CREATE TABLE __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  for (const migration of migrations) {
    database.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      [migration.file, migration.timestamp],
    );
  }
}

async function applyInitialMigration(database: Database): Promise<void> {
  const initialMigration = MIGRATIONS[0];
  await applyMigrationFile(database, initialMigration.file);
  createMigrationJournal(database, [initialMigration]);
}

test("database migration command applies pending migrations", async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "q-mush-migrate-test-"));
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

test("OpenAI migration preserves existing OpenRouter credentials", async () => {
  temporaryDirectory = mkdtempSync(
    join(tmpdir(), "q-mush-provider-upgrade-test-"),
  );
  const databasePath = join(temporaryDirectory, "openrouter.sqlite");
  const legacyDatabase = new Database(databasePath, { create: true });

  for (const migration of MIGRATIONS) {
    await applyMigrationFile(legacyDatabase, migration.file);
  }
  createMigrationJournal(legacyDatabase, MIGRATIONS);

  const timestamp = 1_700_000_000_000;
  const userId = "018bcfe5-6800-7000-8000-000000000071";
  const credentialId = "018bcfe5-6800-7000-8000-000000000072";
  legacyDatabase.run(
    `INSERT INTO users (
      id, google_subject, email, name, created_at, created_by_id,
      updated_at, updated_by_id, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      "provider-migration-google-subject",
      "provider-migration@example.com",
      "Provider Migration",
      timestamp,
      SYSTEM_ID,
      timestamp,
      SYSTEM_ID,
      false,
    ],
  );
  legacyDatabase.run(
    `INSERT INTO openrouter_credentials (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      is_deleted, openrouter_user_id, label, source, encrypted_api_key,
      api_key_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      credentialId,
      userId,
      timestamp,
      userId,
      timestamp,
      userId,
      false,
      "openrouter-account",
      "Migrated key",
      "api_key",
      "encrypted-openrouter-key",
      "openrouter-key-fingerprint",
    ],
  );
  legacyDatabase.close();

  await runMigrationCommand(databasePath);

  const migratedDatabase = createDatabase(databasePath);
  expect(migratedDatabase.select().from(providerCredentials).all()).toEqual([
    {
      createdAt: new Date(timestamp),
      createdById: userId,
      credentialFingerprint: "openrouter-key-fingerprint",
      encryptedCredential: "encrypted-openrouter-key",
      id: credentialId,
      isDefault: false,
      isDeleted: false,
      label: "Migrated key",
      provider: "openrouter",
      providerAccountId: "openrouter-account",
      source: "api_key",
      updatedAt: new Date(timestamp),
      updatedById: userId,
      userId,
    },
  ]);
  migratedDatabase.$client.close();
});

test("migration preserves records created by the initial schema", async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "q-mush-upgrade-test-"));
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
