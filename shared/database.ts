import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentMessages,
  agentPendingInputs,
  agentQuestionRequests,
  agentSessions,
  agentSessionTurns,
  attachmentFallbacks,
  prompts,
  providerCredentials,
  providerCredentialWorkspaces,
  providerQuotaResetReceipts,
  providerQuotaSettings,
  runners,
  runnerWorkspaces,
  sessions,
  users,
  workspaces,
} from "./database/schema.ts";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const databaseSchema = {
  agentMessages,
  agentPendingInputs,
  agentQuestionRequests,
  agentSessions,
  agentSessionTurns,
  attachmentFallbacks,
  prompts,
  providerCredentials,
  providerCredentialWorkspaces,
  providerQuotaResetReceipts,
  providerQuotaSettings,
  runners,
  runnerWorkspaces,
  sessions,
  users,
  workspaces,
};
export type AppDatabase = BunSQLiteDatabase<typeof databaseSchema> & {
  readonly $client: Database;
  noncriticalWrite(action: () => void): void;
};

export function createDatabase(path: string): AppDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const client = new Database(path, { create: true });
  const database = Object.assign(drizzle(client, { schema: databaseSchema }), {
    noncriticalWrite(action: () => void): void {
      action();
    },
  });

  try {
    // Drizzle wraps migrations in a transaction, where SQLite ignores changes
    // to foreign_keys. Disable it beforehand so generated table rebuilds work.
    client.run("PRAGMA foreign_keys = OFF");
    migrate(database, { migrationsFolder: MIGRATIONS_DIRECTORY });
    client.run("PRAGMA foreign_keys = ON");
  } catch (error) {
    client.close();
    throw error;
  }

  return database;
}
