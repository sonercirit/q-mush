import type { AppDatabase } from "../../shared/database.ts";

export function testDatabaseColumns(
  database: AppDatabase,
  table: string,
): readonly { readonly name: string }[] {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Invalid test table name");
  const statement = `PRAGMA table_info(${table})`;
  return database.$client.query<{ readonly name: string }, []>(statement).all();
}
