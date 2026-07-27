import { eq, isNull } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export function nullableColumnCondition(
  column: AnySQLiteColumn,
  value: string | null | undefined,
) {
  return value == null ? isNull(column) : eq(column, value);
}
