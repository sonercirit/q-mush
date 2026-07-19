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

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    userId: userIdColumn(),
    ...auditColumns(),
    provider: text("provider", { enum: ["openai", "openrouter"] }).notNull(),
    providerAccountId: text("provider_account_id"),
    label: text("label").notNull(),
    source: text("source", { enum: ["oauth", "api_key"] }).notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
  },
  (table) => [
    index("provider_credentials_user_provider_deletion_index").on(
      table.userId,
      table.provider,
      table.isDeleted,
    ),
    uniqueIndex("provider_credentials_user_provider_fingerprint_unique").on(
      table.userId,
      table.provider,
      table.credentialFingerprint,
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
