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
const STEP_STARTED_MIGRATION_TIMESTAMP = 1_786_576_532_455;
const MAX_OUTPUT_TOKENS_MIGRATION_TIMESTAMP = 1_786_595_654_131;
const PARENT_REPORT_MIGRATION_TIMESTAMP = 1_786_988_568_031;
const ADAPTIVE_THINKING_MIGRATION_TIMESTAMP = 1_786_746_755_573;

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

function agentSessionColumnNames(database: Database): readonly string[] {
  const query = database.query<{ readonly name: string }, []>(
    "PRAGMA table_info(agent_sessions)",
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
  expect(agentSessionColumnNames(currentBaseDatabase)).not.toContain(
    "user_context_token_cap",
  );
  currentBaseDatabase.close();

  const upgradedDatabase = createDatabase(path);
  expect(agentSessionColumnNames(upgradedDatabase.$client)).toContain(
    "user_context_token_cap",
  );
  const credentialColumns = upgradedDatabase.$client
    .query<{ readonly name: string }, []>(
      "SELECT name FROM pragma_table_info('provider_credentials')",
    )
    .all()
    .map((column) => column.name);
  expect(credentialColumns).toContain("api_format");
  expect(agentSessionColumnNames(upgradedDatabase.$client)).toContain(
    "idle_compact",
  );
  expect(agentSessionColumnNames(upgradedDatabase.$client)).toContain(
    "step_started_at",
  );
  expect(agentSessionColumnNames(upgradedDatabase.$client)).toContain(
    "max_output_tokens",
  );
  expect(agentSessionColumnNames(upgradedDatabase.$client)).toContain(
    "adaptive_thinking",
  );
  const migrationTimestamps = upgradedDatabase.$client
    .query<{ readonly createdAt: number }, []>(
      "SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 4",
    )
    .all()
    .map(({ createdAt }) => createdAt);
  expect(migrationTimestamps).toEqual([
    PARENT_REPORT_MIGRATION_TIMESTAMP,
    ADAPTIVE_THINKING_MIGRATION_TIMESTAMP,
    MAX_OUTPUT_TOKENS_MIGRATION_TIMESTAMP,
    STEP_STARTED_MIGRATION_TIMESTAMP,
  ]);
  upgradedDatabase.$client.close();
});
