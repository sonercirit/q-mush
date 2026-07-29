import { integer, text } from "drizzle-orm/sqlite-core";

export function auditColumns() {
  return {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    createdById: text("created_by_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    updatedById: text("updated_by_id").notNull(),
    isDeleted: integer("is_deleted", { mode: "boolean" })
      .notNull()
      .default(false),
  };
}
