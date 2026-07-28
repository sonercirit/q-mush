import { count, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";

interface SelectedIdentifier {
  readonly column: AnySQLiteColumn;
  readonly table: SQLiteTable;
}

export function countSelectedRows(
  database: Pick<AppDatabase, "select">,
  table: Parameters<ReturnType<AppDatabase["select"]>["from"]>[0],
  condition: SQL | undefined,
): number {
  const counted = database
    .select({ value: count() })
    .from(table)
    .where(condition)
    .get();
  return counted?.value ?? 0;
}

export function selectedString(
  database: Pick<AppDatabase, "select">,
  selected: SelectedIdentifier,
  condition: SQL | undefined,
): string | undefined {
  return selectedStringValue({ condition, database, selected });
}

interface SelectedStringOptions {
  readonly condition: SQL | undefined;
  readonly database: Pick<AppDatabase, "select">;
  readonly selected: SelectedIdentifier;
}

function selectedStringValue(
  options: SelectedStringOptions,
): string | undefined {
  const row = options.database
    .select({ value: options.selected.column })
    .from(options.selected.table)
    .where(options.condition)
    .get();
  return typeof row?.value === "string" ? row.value : undefined;
}
