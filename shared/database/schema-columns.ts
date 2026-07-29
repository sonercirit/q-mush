import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { auditColumns } from "./audit-columns.ts";

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
