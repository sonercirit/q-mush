import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  MINIMUM_TOOL_OUTPUT_CHARACTERS,
} from "../tool-limits.ts";
import { ownedAuditColumns } from "./schema-columns.ts";

export function createToolSettingsTable(userId: () => AnySQLiteColumn) {
  return sqliteTable(
    "tool_settings",
    {
      ...ownedAuditColumns(userId),
      executionLimitMinutes: integer("execution_limit_minutes").notNull(),
      outputLimitCharacters: integer("output_limit_characters").notNull(),
    },
    (table) => [
      index("tool_settings_user_deletion_index").on(
        table.userId,
        table.isDeleted,
      ),
      uniqueIndex("tool_settings_user_active_unique")
        .on(table.userId)
        .where(sql`NOT ${table.isDeleted}`),
      check(
        "tool_settings_execution_range_check",
        sql`${table.executionLimitMinutes} >= 1 AND ${table.executionLimitMinutes} <= ${sql.raw(String(MAXIMUM_TOOL_EXECUTION_MINUTES))}`,
      ),
      check(
        "tool_settings_output_range_check",
        sql`${table.outputLimitCharacters} >= ${sql.raw(String(MINIMUM_TOOL_OUTPUT_CHARACTERS))} AND ${table.outputLimitCharacters} <= ${sql.raw(String(MAXIMUM_TOOL_OUTPUT_CHARACTERS))}`,
      ),
    ],
  );
}
