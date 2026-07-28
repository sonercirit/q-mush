import type { AppDatabase } from "../database.ts";

export function hasTestDatabaseTable(
  database: AppDatabase,
  tableName: string,
): boolean {
  return (
    database.$client
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== null
  );
}
