import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./database/schema.ts";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
export type AppDatabase = BunSQLiteDatabase<typeof schema> & {
  readonly $client: Database;
};

export function createDatabase(path: string): AppDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const client = new Database(path, { create: true });
  client.run("PRAGMA foreign_keys = ON");
  const database = drizzle(client, { schema });

  try {
    migrate(database, { migrationsFolder: MIGRATIONS_DIRECTORY });
  } catch (error) {
    client.close();
    throw error;
  }

  return database;
}
