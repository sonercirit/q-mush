import { count, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";

interface SelectedValue {
  readonly column: AnySQLiteColumn;
  readonly table: SQLiteTable;
}

interface SelectedValueOptions {
  readonly condition: SQL | undefined;
  readonly database: Pick<AppDatabase, "select">;
  readonly selected: SelectedValue;
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
  selected: SelectedValue,
  condition: SQL | undefined,
): string | undefined {
  const value = selectedValue({ condition, database, selected });
  return typeof value === "string" ? value : undefined;
}

export function selectedValue(options: SelectedValueOptions): unknown {
  return options.database
    .select({ value: options.selected.column })
    .from(options.selected.table)
    .where(options.condition)
    .get()?.value;
}
