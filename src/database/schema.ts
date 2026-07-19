import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

function auditColumns() {
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

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSubject: text("google_subject").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  picture: text("picture"),
  ...auditColumns(),
});

function userIdColumn() {
  return text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" });
}

export const openRouterCredentials = sqliteTable(
  "openrouter_credentials",
  {
    id: text("id").primaryKey(),
    userId: userIdColumn(),
    ...auditColumns(),
    openRouterUserId: text("openrouter_user_id"),
    label: text("label").notNull(),
    source: text("source", { enum: ["oauth", "api_key"] }).notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    apiKeyFingerprint: text("api_key_fingerprint").notNull(),
  },
  (table) => [
    index("openrouter_credentials_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    uniqueIndex("openrouter_credentials_user_fingerprint_unique").on(
      table.userId,
      table.apiKeyFingerprint,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: userIdColumn(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...auditColumns(),
  },
  (table) => [
    index("sessions_user_id_index").on(table.userId),
    index("sessions_deletion_expiry_index").on(
      table.isDeleted,
      table.expiresAt,
    ),
  ],
);
