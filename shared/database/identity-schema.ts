import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { PROVIDER_API_FORMATS } from "../provider-id.ts";
import { auditColumns } from "./audit-columns.ts";
import {
  connectionColumns,
  credentialProviderColumn,
} from "./provider-columns.ts";
import {
  activeDefaultIndex,
  ownedAuditColumns,
  ownedForeignKey,
} from "./schema-columns.ts";

export function identityAndCredentialTables() {
  const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    googleSubject: text("google_subject").notNull().unique(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    picture: text("picture"),
    ...auditColumns(),
  });
  const userIdColumn = () => ownedForeignKey("user_id", () => users.id);
  const userOwnedAuditColumns = () => ownedAuditColumns(() => users.id);
  const workspaces = sqliteTable(
    "workspaces",
    {
      id: text("id").primaryKey(),
      userId: userIdColumn(),
      name: text("name").notNull(),
      isDefault: connectionColumns().isDefault,
      ...auditColumns(),
    },
    (table) => [
      index("workspaces_user_id_index").on(table.userId, table.id),
      index("workspaces_user_deletion_index").on(table.userId, table.isDeleted),
      index("workspaces_user_active_name_index")
        .on(table.userId, table.name)
        .where(sql`NOT ${table.isDeleted}`),
      activeDefaultIndex("workspaces_user_default_unique")(table),
    ],
  );
  const prompts = sqliteTable(
    "prompts",
    {
      ...userOwnedAuditColumns(),
      name: text("name").notNull(),
      normalizedName: text("normalized_name").notNull(),
      body: text("body").notNull(),
      revision: integer("revision").notNull().default(1),
    },
    (table) => [
      index("prompts_user_id_index").on(table.userId, table.id),
      index("prompts_user_deletion_update_index").on(
        table.userId,
        table.isDeleted,
        table.updatedAt,
      ),
      uniqueIndex("prompts_user_normalized_name_active_unique")
        .on(table.userId, table.normalizedName)
        .where(sql`NOT ${table.isDeleted}`),
      check("prompts_revision_positive_check", sql`${table.revision} > 0`),
    ],
  );
  const providerCredentials = sqliteTable(
    "provider_credentials",
    {
      ...userOwnedAuditColumns(),
      provider: credentialProviderColumn(),
      providerAccountId: text("provider_account_id"),
      baseUrl: text("base_url"),
      apiFormat: text("api_format", { enum: PROVIDER_API_FORMATS }),
      label: text("label").notNull(),
      source: text("source", { enum: ["oauth", "api_key"] }).notNull(),
      encryptedCredential: text("encrypted_credential").notNull(),
      credentialFingerprint: text("credential_fingerprint").notNull(),
      requiresReauthentication: integer("requires_reauthentication", {
        mode: "boolean",
      })
        .notNull()
        .default(false),
      ...connectionColumns(),
    },
    (table) => [
      index("provider_credentials_user_id_index").on(table.userId, table.id),
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
      uniqueIndex("provider_credentials_user_model_default_unique")
        .on(table.userId)
        .where(
          sql`${table.provider} IN ('openai', 'openrouter', 'generic') AND ${table.isDefault} AND NOT ${table.isDeleted}`,
        ),
    ],
  );
  return { prompts, providerCredentials, users, workspaces };
}
