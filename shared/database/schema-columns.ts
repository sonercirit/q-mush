import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  integer,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { auditColumns } from "./audit-columns.ts";

export function sessionContextColumns() {
  return {
    currentContextTokens: integer("current_context_tokens")
      .notNull()
      .default(0),
    maxContextTokens: integer("max_context_tokens"),
    userContextTokenCap: integer("user_context_token_cap"),
  };
}

export function ownedForeignKey(
  name: string,
  reference: () => AnySQLiteColumn,
) {
  return text(name).notNull().references(reference, { onDelete: "restrict" });
}

export function ownedAuditColumns(userReference: () => AnySQLiteColumn) {
  return {
    id: text("id").primaryKey(),
    userId: ownedForeignKey("user_id", userReference),
    ...auditColumns(),
  };
}

export function tokenUsageColumns() {
  return {
    cacheWriteInputTokens: integer("cache_write_input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  };
}

export function activeDefaultIndex(name: string) {
  return (table: {
    readonly isDefault: AnySQLiteColumn;
    readonly isDeleted: AnySQLiteColumn;
    readonly userId: AnySQLiteColumn;
  }) =>
    uniqueIndex(name)
      .on(table.userId)
      .where(sql`NOT ${table.isDeleted} AND ${table.isDefault}`);
}
