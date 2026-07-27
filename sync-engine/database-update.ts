import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";

export function exactlyOneRow<Row>(rows: readonly Row[]): Row | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

export function exactlyOneUpdatedRow(
  database: Pick<AppDatabase, "update">,
  table: SQLiteTable,
  values: Readonly<Record<string, unknown>>,
  condition: Parameters<
    ReturnType<ReturnType<AppDatabase["update"]>["set"]>["where"]
  >[0],
  id: AnySQLiteColumn,
): boolean {
  return (
    database.update(table).set(values).where(condition).returning({ id }).all()
      .length === 1
  );
}
