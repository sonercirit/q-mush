import type { Database } from "bun:sqlite";

export function readSqlitePragmaNumber(
  database: Database,
  pragma: string,
): number {
  const rows: unknown[][] = database.query(`PRAGMA ${pragma}`).values();
  return typeof rows[0]?.[0] === "number" ? rows[0][0] : 0;
}
