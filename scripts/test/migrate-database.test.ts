import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import {
  agentMessages,
  agentSessions,
  providerCredentials,
  sessions,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");
const MIGRATIONS = [
  { file: "0000_whole_paibok.sql", timestamp: 1_784_476_796_446 },
  { file: "0001_audited-identifiers.sql", timestamp: 1_784_478_537_706 },
  { file: "0002_swift_micromacro.sql", timestamp: 1_784_484_507_050 },
] as const;
const AGENT_SESSION_MIGRATIONS = [
  ...MIGRATIONS,
  { file: "0003_first_talos.sql", timestamp: 1_784_490_290_030 },
  { file: "0004_yummy_ma_gnuci.sql", timestamp: 1_784_497_769_503 },
  { file: "0005_unusual_madrox.sql", timestamp: 1_784_511_387_878 },
  { file: "0006_rainy_norrin_radd.sql", timestamp: 1_784_516_569_469 },
  { file: "0007_foamy_mercury.sql", timestamp: 1_784_531_749_727 },
  { file: "0008_dry_prowler.sql", timestamp: 1_784_561_914_460 },
  { file: "0009_mature_korg.sql", timestamp: 1_784_632_073_725 },
  { file: "0010_silky_spacker_dave.sql", timestamp: 1_784_645_366_890 },
  {
    file: "0011_friendly_stark_industries.sql",
    timestamp: 1_784_659_836_986,
  },
  { file: "0012_damp_khan.sql", timestamp: 1_784_773_990_609 },
  { file: "0013_session-tools.sql", timestamp: 1_784_776_192_396 },
] as const;
const WORKSPACE_MIGRATIONS = [
  ...AGENT_SESSION_MIGRATIONS,
  { file: "0014_mushy_jean_grey.sql", timestamp: 1_784_825_553_938 },
  { file: "0015_agent-message-errors.sql", timestamp: 1_784_832_440_988 },
  { file: "0016_thankful_silver_sable.sql", timestamp: 1_784_845_867_828 },
  { file: "0017_plain_silver_samurai.sql", timestamp: 1_784_917_618_203 },
  { file: "0018_tranquil_mephisto.sql", timestamp: 1_784_993_749_108 },
] as const;
const CURRENT_AGENT_SESSION_TOOLS =
  '["read","bash","edit","write","parallel","brave_search","spawn_session","browse_runner_directories","list_runners","list_sessions","get_session_options","read_session","reassign_session","send_to_session","continue_session","stop_session"]';
const PREVIOUS_AGENT_SESSION_TOOLS =
  '["read","bash","edit","write","parallel","brave_search","spawn_session","list_sessions","read_session","send_to_session","continue_session","stop_session"]';

const SESSION_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const UUID_V7_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

type LegacySessionFixture = Readonly<{
  credentialId: string;
  runnerId: string;
  sessionId: string;
  timestamp: number;
  userId: string;
}>;

interface Migration {
  readonly file: string;
  readonly timestamp: number;
}

let temporaryDirectory: string | undefined;

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
  migrations: readonly Migration[],
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

async function createLegacyDatabase(
  directoryPrefix: string,
  file: string,
  migrations: readonly Migration[],
): Promise<{ readonly database: Database; readonly path: string }> {
  temporaryDirectory = mkdtempSync(join(tmpdir(), directoryPrefix));
  const path = join(temporaryDirectory, file);
  const database = new Database(path, { create: true });

  for (const migration of migrations) {
    await applyMigrationFile(database, migration.file);
  }
  createMigrationJournal(database, migrations);

  return { database, path };
}

function insertLegacySessionFixture(
  database: Database,
  fixture: LegacySessionFixture,
): void {
  const { credentialId, runnerId, sessionId, timestamp, userId } = fixture;
  database.run(
    `INSERT INTO users (
      id, google_subject, email, name, created_at, created_by_id,
      updated_at, updated_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      "session-migration-google-subject",
      "session-migration@example.com",
      "Session Migration",
      timestamp,
      SYSTEM_ID,
      timestamp,
      SYSTEM_ID,
    ],
  );
  database.run(
    `INSERT INTO provider_credentials (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      provider, label, source, encrypted_credential, credential_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      credentialId,
      userId,
      timestamp,
      userId,
      timestamp,
      userId,
      "openrouter",
      "Session migration key",
      "api_key",
      "encrypted-session-migration-key",
      "session-migration-key-fingerprint",
    ],
  );
  database.run(
    `INSERT INTO runners (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      token_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runnerId,
      userId,
      timestamp,
      userId,
      timestamp,
      userId,
      "session-migration-runner-token-hash",
    ],
  );
  database.run(
    `INSERT INTO agent_sessions (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      runner_id, provider_credential_id, provider, model, working_directory,
      title, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      userId,
      timestamp,
      userId,
      timestamp,
      userId,
      runnerId,
      credentialId,
      "openrouter",
      "openai/gpt-4.1-mini",
      "/workspace",
      "Existing session",
      "idle",
    ],
  );
}

async function migrateLegacyDatabase(
  database: Database,
  path: string,
): Promise<AppDatabase> {
  database.close();
  await runMigrationCommand(path);
  return createDatabase(path);
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

test("session migration preserves transcripts with foreign keys", async () => {
  const { database: legacyDatabase, path } = await createLegacyDatabase(
    "q-mush-session-upgrade-test-",
    "sessions.sqlite",
    AGENT_SESSION_MIGRATIONS,
  );

  const timestamp = 1_700_000_000_000;
  const userId = "018bcfe5-6800-7000-8000-000000000081";
  const credentialId = "018bcfe5-6800-7000-8000-000000000082";
  const runnerId = "018bcfe5-6800-7000-8000-000000000083";
  const sessionId = "018bcfe5-6800-7000-8000-000000000084";
  const messageId = "018bcfe5-6800-7000-8000-000000000085";
  const errorMessageId = "018bcfe5-6800-7000-8000-000000000086";
  insertLegacySessionFixture(legacyDatabase, {
    credentialId,
    runnerId,
    sessionId,
    timestamp,
    userId,
  });
  legacyDatabase.run("UPDATE agent_sessions SET tools = ? WHERE id = ?", [
    PREVIOUS_AGENT_SESSION_TOOLS,
    sessionId,
  ]);
  legacyDatabase.run(
    `INSERT INTO agent_messages (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      session_id, role, content
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      messageId,
      userId,
      timestamp,
      userId,
      timestamp,
      userId,
      sessionId,
      "user",
      "Preserve this message",
    ],
  );
  legacyDatabase.run(
    `INSERT INTO agent_messages (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      session_id, role, content
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      errorMessageId,
      userId,
      timestamp + 1,
      SYSTEM_ID,
      timestamp + 1,
      SYSTEM_ID,
      sessionId,
      "system",
      "Session failed: legacy provider error",
    ],
  );
  const upgradedDatabase = await migrateLegacyDatabase(legacyDatabase, path);
  expect(
    upgradedDatabase
      .select({
        id: agentSessions.id,
        parentExecutionGeneration: agentSessions.parentExecutionGeneration,
        parentSessionId: agentSessions.parentSessionId,
        runnerRequired: agentSessions.runnerRequired,
        tools: agentSessions.tools,
      })
      .from(agentSessions)
      .all(),
  ).toEqual([
    {
      id: sessionId,
      parentExecutionGeneration: null,
      parentSessionId: null,
      runnerRequired: false,
      tools: CURRENT_AGENT_SESSION_TOOLS,
    },
  ]);
  expect(
    upgradedDatabase
      .select({
        content: agentMessages.content,
        id: agentMessages.id,
        role: agentMessages.role,
      })
      .from(agentMessages)
      .all(),
  ).toEqual([
    { content: "Preserve this message", id: messageId, role: "user" },
    {
      content: "Session failed: legacy provider error",
      id: errorMessageId,
      role: "error",
    },
  ]);
  expect(
    upgradedDatabase.$client.query("PRAGMA foreign_key_check").all(),
  ).toEqual([]);
  expect(upgradedDatabase.$client.query("PRAGMA foreign_keys").get()).toEqual({
    foreign_keys: 1,
  });
  upgradedDatabase.$client.close();
});

test("0019 migrates workspace and runner data", async () => {
  const { database: legacyDatabase, path } = await createLegacyDatabase(
    "q-mush-0019-",
    "db.sqlite",
    WORKSPACE_MIGRATIONS,
  );
  const fixtures = {
    credentialId: "018bcfe5-6800-7000-8000-000000000092",
    runnerId: "018bcfe5-6800-7000-8000-000000000093",
    sessionId: "018bcfe5-6800-7000-8000-000000000094",
    timestamp: 1_700_000_000_000,
    userId: "018bcfe5-6800-7000-8000-000000000091",
  };
  insertLegacySessionFixture(legacyDatabase, fixtures);
  legacyDatabase.close();
  await runMigrationCommand(path);

  const migratedDatabase = new Database(path, { readonly: true });
  const workspaces = migratedDatabase
    .query<
      {
        readonly id: string;
        readonly isDefault: number;
        readonly userId: string;
      },
      []
    >("SELECT id, is_default AS isDefault, user_id AS userId FROM workspaces")
    .all();
  expect(workspaces).toEqual([
    { id: fixtures.userId, isDefault: 1, userId: fixtures.userId },
  ]);
  expect(
    migratedDatabase
      .query<{ readonly workspaceId: string }, []>(
        "SELECT workspace_id AS workspaceId FROM agent_sessions",
      )
      .get(),
  ).toEqual({ workspaceId: fixtures.userId });
  expect(
    migratedDatabase
      .query<
        {
          readonly activationGeneration: number;
          readonly activationId: null;
          readonly activationLifecycle: null;
          readonly activationPhase: null;
          readonly isGlobal: number;
          readonly tokenDigest: string;
        },
        []
      >(
        `SELECT activation_generation AS activationGeneration,
        activation_id AS activationId, activation_lifecycle AS activationLifecycle,
        activation_phase AS activationPhase, is_global AS isGlobal,
        token_digest AS tokenDigest FROM runners`,
      )
      .get(),
  ).toEqual({
    activationGeneration: 0,
    activationId: null,
    activationLifecycle: null,
    activationPhase: null,
    isGlobal: 1,
    tokenDigest: "",
  });

  const constraintsDatabase = Database.deserialize(
    migratedDatabase.serialize(),
  );
  migratedDatabase.close();
  expect(() => {
    constraintsDatabase
      .query(
        "UPDATE runners SET activation_id = 'a', activation_lifecycle = 'ordinary' WHERE id = ?",
      )
      .run(fixtures.runnerId);
  }).toThrow("runners_activation_phase_identity_check");
  expect(() =>
    constraintsDatabase.run(
      "UPDATE runners SET activation_restart_id = 'restart' WHERE id = ?",
      [fixtures.runnerId],
    ),
  ).toThrow("runners_activation_lifecycle_restart_check");
  expect(() => {
    constraintsDatabase.run(
      `UPDATE runners SET activation_phase = 'prepared', activation_id = 'a',
        activation_source_id = 'source', activation_target_id = 'target',
        activation_target_generation = 0, activation_machine_fingerprint = 'machine',
        activation_platform = 'linux', activation_architecture = 'x64',
        activation_name = 'Runner' WHERE runners.id = ?`,
      [fixtures.runnerId],
    );
  }).toThrow("runners_activation_phase_identity_check");
  expect(() =>
    constraintsDatabase.run(
      `UPDATE runners SET activation_phase = 'prepared', activation_id = 'valid',
        activation_lifecycle = 'restart', activation_restart_id = 'restart',
        activation_source_id = 'activation-source',
        activation_target_id = 'activation-target', activation_target_generation = 1,
        activation_machine_fingerprint = 'fingerprint', activation_platform = 'darwin',
        activation_architecture = 'arm64', activation_name = 'Activated Runner'
        WHERE id = ?`,
      [fixtures.runnerId],
    ),
  ).not.toThrow();
  const otherRunnerId = "018bcfe5-6800-7000-8000-000000000095";
  constraintsDatabase.run(
    `INSERT INTO runners (id, user_id, created_at, created_by_id, updated_at,
      updated_by_id, token_hash) SELECT ?, user_id, created_at, created_by_id,
      updated_at, updated_by_id, 'other-token-hash' FROM runners WHERE id = ?`,
    [otherRunnerId, fixtures.runnerId],
  );
  constraintsDatabase.run(
    "UPDATE runners SET token_digest = 'digest' WHERE id = ?",
    [fixtures.runnerId],
  );
  expect(() =>
    constraintsDatabase.run(
      "UPDATE runners SET token_digest = 'digest' WHERE id = ?",
      [otherRunnerId],
    ),
  ).toThrow("UNIQUE constraint failed: runners.token_digest");
  constraintsDatabase.close();
});

test("preserves existing OpenRouter credentials", async () => {
  const { database: legacyDatabase, path } = await createLegacyDatabase(
    "q-mush-provider-upgrade-test-",
    "openrouter.sqlite",
    MIGRATIONS,
  );

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
  const migratedDatabase = await migrateLegacyDatabase(legacyDatabase, path);
  expect(migratedDatabase.select().from(providerCredentials).all()).toEqual([
    {
      baseUrl: null,
      createdAt: new Date(timestamp),
      createdById: userId,
      credentialFingerprint: "openrouter-key-fingerprint",
      encryptedCredential: "encrypted-openrouter-key",
      id: credentialId,
      isDefault: false,
      isDeleted: false,
      isGlobal: true,
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

test("preserves records from the initial schema", async () => {
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
