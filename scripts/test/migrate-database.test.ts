import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase, type AppDatabase } from "../../shared/database.ts";
import {
  agentMessages,
  agentPendingInputs,
  agentSessions,
  providerCredentials,
  sessions,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";

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
const PENDING_INPUT_MIGRATIONS = [
  ...AGENT_SESSION_MIGRATIONS,
  { file: "0014_mushy_jean_grey.sql", timestamp: 1_784_825_553_938 },
  { file: "0015_agent-message-errors.sql", timestamp: 1_784_832_440_988 },
  { file: "0016_polite_the_professor.sql", timestamp: 1_784_843_598_313 },
] as const;
const SESSION_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const UUID_V7_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

interface LegacyAgentSessionSeed {
  readonly credentialId: string;
  readonly runnerId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly userId: string;
}

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

async function migrateLegacyDatabase(
  database: Database,
  path: string,
): Promise<AppDatabase> {
  database.close();
  await runMigrationCommand(path);
  return createDatabase(path);
}

function seedLegacyAgentSession(database: Database): LegacyAgentSessionSeed {
  const seed = {
    credentialId: "018bcfe5-6800-7000-8000-000000000092",
    runnerId: "018bcfe5-6800-7000-8000-000000000093",
    sessionId: "018bcfe5-6800-7000-8000-000000000094",
    timestamp: 1_700_000_000_000,
    userId: "018bcfe5-6800-7000-8000-000000000091",
  } as const;
  database.run(
    `INSERT INTO users (
      id, google_subject, email, name, created_at, created_by_id,
      updated_at, updated_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.userId,
      "pending-migration-google-subject",
      "pending-migration@example.com",
      "Pending Migration",
      seed.timestamp,
      SYSTEM_ID,
      seed.timestamp,
      SYSTEM_ID,
    ],
  );
  database.run(
    `INSERT INTO provider_credentials (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      provider, label, source, encrypted_credential, credential_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.credentialId,
      ...ownedAuditValues(seed),
      "openrouter",
      "Pending migration key",
      "api_key",
      "encrypted-pending-migration-key",
      "pending-migration-key-fingerprint",
    ],
  );
  database.run(
    `INSERT INTO runners (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      token_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.runnerId,
      ...ownedAuditValues(seed),
      "pending-migration-runner-token-hash",
    ],
  );
  database.run(
    `INSERT INTO agent_sessions (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      runner_id, provider_credential_id, provider, model, working_directory,
      title, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.sessionId,
      ...ownedAuditValues(seed),
      seed.runnerId,
      seed.credentialId,
      "openrouter",
      "openai/gpt-4.1-mini",
      "/workspace",
      "Pending migration session",
      "running",
    ],
  );
  return seed;
}

function ownedAuditValues(seed: LegacyAgentSessionSeed) {
  return [
    seed.userId,
    seed.timestamp,
    seed.userId,
    seed.timestamp,
    seed.userId,
  ] as const;
}

function insertLegacyPendingInput(
  database: Database,
  seed: LegacyAgentSessionSeed,
  input: {
    readonly createdAt: number;
    readonly id: string;
    readonly isDeleted?: boolean;
    readonly kind: "follow_up" | "steer";
  },
): void {
  database.run(
    `INSERT INTO agent_pending_inputs (
      id, user_id, created_at, created_by_id, updated_at, updated_by_id,
      is_deleted, session_id, client_request_id, kind, content, images
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      seed.userId,
      input.createdAt,
      seed.userId,
      input.createdAt,
      seed.userId,
      input.isDeleted ?? false,
      seed.sessionId,
      `request-${input.id}`,
      input.kind,
      `content-${input.id}`,
      null,
    ],
  );
}

function expectNoForeignKeyViolations(database: AppDatabase): void {
  expect(database.$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
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

test("pending-input migration backfills a deterministic durable sequence", async () => {
  const { database: legacyDatabase, path } = await createLegacyDatabase(
    "q-mush-pending-input-upgrade-test-",
    "pending-inputs.sqlite",
    PENDING_INPUT_MIGRATIONS,
  );
  const seed = seedLegacyAgentSession(legacyDatabase);
  const legacyInputs = [
    { createdAt: seed.timestamp + 2, id: "pending-z", kind: "steer" },
    { createdAt: seed.timestamp + 1, id: "pending-a", kind: "follow_up" },
    {
      createdAt: seed.timestamp + 1,
      id: "pending-m",
      isDeleted: true,
      kind: "steer",
    },
  ] as const;
  for (const input of legacyInputs) {
    insertLegacyPendingInput(legacyDatabase, seed, input);
  }

  const upgradedDatabase = await migrateLegacyDatabase(legacyDatabase, path);
  expect(
    upgradedDatabase
      .select({
        content: agentPendingInputs.content,
        id: agentPendingInputs.id,
        isDeleted: agentPendingInputs.isDeleted,
        sequence: agentPendingInputs.sequence,
      })
      .from(agentPendingInputs)
      .all(),
  ).toEqual([
    {
      content: "content-pending-a",
      id: "pending-a",
      isDeleted: false,
      sequence: 1,
    },
    {
      content: "content-pending-m",
      id: "pending-m",
      isDeleted: true,
      sequence: 2,
    },
    {
      content: "content-pending-z",
      id: "pending-z",
      isDeleted: false,
      sequence: 3,
    },
  ]);
  expect(
    new SessionStore(upgradedDatabase).get(seed.userId, seed.sessionId)
      ?.pendingInputs,
  ).toEqual([
    {
      content: "content-pending-a",
      createdAt: seed.timestamp + 1,
      id: "pending-a",
      images: [],
      kind: "follow_up",
    },
    {
      content: "content-pending-z",
      createdAt: seed.timestamp + 2,
      id: "pending-z",
      images: [],
      kind: "steer",
    },
  ]);
  expect(() =>
    upgradedDatabase.$client.run(
      "UPDATE agent_pending_inputs SET sequence = 1 WHERE id = ?",
      ["pending-z"],
    ),
  ).toThrow();
  expectNoForeignKeyViolations(upgradedDatabase);
  upgradedDatabase.$client.close();
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
  legacyDatabase.run(
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
  legacyDatabase.run(
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
  legacyDatabase.run(
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
  legacyDatabase.run(
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
        parentSessionId: agentSessions.parentSessionId,
      })
      .from(agentSessions)
      .all(),
  ).toEqual([{ id: sessionId, parentSessionId: null }]);
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
  expectNoForeignKeyViolations(upgradedDatabase);
  expect(upgradedDatabase.$client.query("PRAGMA foreign_keys").get()).toEqual({
    foreign_keys: 1,
  });
  upgradedDatabase.$client.close();
});

test("OpenAI migration preserves existing OpenRouter credentials", async () => {
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
