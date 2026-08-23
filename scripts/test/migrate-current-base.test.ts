import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../../shared/database.ts";

const DRIZZLE_DIRECTORY = join(import.meta.dirname, "../../drizzle");
const CURRENT_BASE_MIGRATIONS = [
  "0000_whole_paibok.sql",
  "0001_audited-identifiers.sql",
  "0002_swift_micromacro.sql",
  "0003_first_talos.sql",
  "0004_yummy_ma_gnuci.sql",
  "0005_unusual_madrox.sql",
  "0006_rainy_norrin_radd.sql",
  "0007_foamy_mercury.sql",
  "0008_dry_prowler.sql",
  "0009_mature_korg.sql",
  "0010_silky_spacker_dave.sql",
  "0011_friendly_stark_industries.sql",
  "0012_damp_khan.sql",
  "0013_session-tools.sql",
  "0014_mushy_jean_grey.sql",
  "0015_agent-message-errors.sql",
  "0016_thankful_silver_sable.sql",
  "0017_plain_silver_samurai.sql",
  "0018_tranquil_mephisto.sql",
  "0019_new_albert_cleary.sql",
  "0020_abnormal_bruce_banner.sql",
  "0021_free_crystal.sql",
  "0022_far_magma.sql",
  "0023_massive_peter_quill.sql",
  "0024_cynical_nitro.sql",
  "0025_curly_nicolaos.sql",
  "0026_skinny_polaris.sql",
  "0027_worthless_sentinels.sql",
] as const;
const CURRENT_BASE_TIMESTAMP = 1_785_753_783_416;
const MAX_OUTPUT_TOKENS_MIGRATION_TIMESTAMP = 1_786_595_654_131;
const PARENT_REPORT_MIGRATION_TIMESTAMP = 1_787_268_023_468;
const TOOL_SETTINGS_MIGRATION_TIMESTAMP = 1_786_905_773_660;
const CREDENTIAL_REAUTHENTICATION_MIGRATION_TIMESTAMP = 1_787_417_810_687;
const ADAPTIVE_THINKING_MIGRATION_TIMESTAMP = 1_786_746_755_573;
const PROVIDER_REPLAY_MIGRATION_TIMESTAMP = 1_787_430_433_213;

let temporaryDirectory: string | undefined;

afterEach(() => {
  const disposable = temporaryDirectory;
  temporaryDirectory = undefined;
  if (disposable !== undefined) rmSync(disposable, { recursive: true });
});

async function applyMigration(database: Database, file: string): Promise<void> {
  const contents = await Bun.file(join(DRIZZLE_DIRECTORY, file)).text();
  const statements = contents.split("--> statement-breakpoint");
  for (const statement of statements) {
    if (statement.trim().length !== 0) database.run(statement.trim());
  }
}

function tableColumnNames(
  database: Database,
  table: "agent_messages" | "agent_sessions",
): readonly string[] {
  const query = database.query<{ readonly name: string }, []>(
    `PRAGMA table_info(${table})`,
  );
  return query.all().map((column) => column.name);
}

test("upgrades migration 0027 through the latest migrations", async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "q-mush-base-upgrade-"));
  const path = join(temporaryDirectory, "current-base.sqlite");
  const currentBaseDatabase = new Database(path, { create: true });
  for (const migration of CURRENT_BASE_MIGRATIONS) {
    await applyMigration(currentBaseDatabase, migration);
  }
  currentBaseDatabase.run(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  currentBaseDatabase.run(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ["0027_worthless_sentinels.sql", CURRENT_BASE_TIMESTAMP],
  );
  expect(tableColumnNames(currentBaseDatabase, "agent_sessions")).not.toContain(
    "user_context_token_cap",
  );
  expect(tableColumnNames(currentBaseDatabase, "agent_messages")).not.toContain(
    "provider_replay",
  );
  currentBaseDatabase.close();

  const upgradedDatabase = createDatabase(path);
  expect(
    tableColumnNames(upgradedDatabase.$client, "agent_sessions"),
  ).toContain("user_context_token_cap");
  const credentialColumns = upgradedDatabase.$client
    .query<{ readonly name: string }, []>(
      "SELECT name FROM pragma_table_info('provider_credentials')",
    )
    .all()
    .map((column) => column.name);
  expect(credentialColumns).toContain("api_format");
  const sessionColumns = tableColumnNames(
    upgradedDatabase.$client,
    "agent_sessions",
  );
  for (const column of [
    "idle_compact",
    "step_started_at",
    "max_output_tokens",
    "adaptive_thinking",
    "parent_callback_generation",
    "spawn_preparation_pending",
  ]) {
    expect(sessionColumns).toContain(column);
  }
  expect(
    tableColumnNames(upgradedDatabase.$client, "agent_messages"),
  ).toContain("provider_replay");
  const migrationTimestamps = upgradedDatabase.$client
    .query<{ readonly createdAt: number }, []>(
      "SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 7",
    )
    .all()
    .map(({ createdAt }) => createdAt);
  expect(migrationTimestamps).toEqual([
    PROVIDER_REPLAY_MIGRATION_TIMESTAMP,
    CREDENTIAL_REAUTHENTICATION_MIGRATION_TIMESTAMP,
    1_787_359_766_762,
    PARENT_REPORT_MIGRATION_TIMESTAMP,
    TOOL_SETTINGS_MIGRATION_TIMESTAMP,
    ADAPTIVE_THINKING_MIGRATION_TIMESTAMP,
    MAX_OUTPUT_TOKENS_MIGRATION_TIMESTAMP,
  ]);
  upgradedDatabase.$client.close();
});
