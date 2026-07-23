import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { AGENT_REASONING_EFFORTS } from "../agent-configuration.ts";
import { AGENT_FILE_NAMES } from "../agent-file.ts";

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

function ownedAuditColumns() {
  return {
    id: text("id").primaryKey(),
    userId: userIdColumn(),
    ...auditColumns(),
  };
}

function defaultBooleanColumn() {
  return integer("is_default", { mode: "boolean" }).notNull().default(false);
}

function providerColumn() {
  return text("provider", { enum: ["openai", "openrouter"] }).notNull();
}

function credentialProviderColumn() {
  return text("provider", {
    enum: ["openai", "openrouter", "brave_search"],
  }).notNull();
}

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    ...ownedAuditColumns(),
    provider: credentialProviderColumn(),
    providerAccountId: text("provider_account_id"),
    label: text("label").notNull(),
    source: text("source", { enum: ["oauth", "api_key"] }).notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    isDefault: defaultBooleanColumn(),
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
    uniqueIndex("provider_credentials_user_model_default_unique")
      .on(table.userId)
      .where(
        sql`${table.provider} IN ('openai', 'openrouter') AND ${table.isDefault} AND NOT ${table.isDeleted}`,
      ),
  ],
);

export const runners = sqliteTable(
  "runners",
  {
    ...ownedAuditColumns(),
    name: text("name"),
    machineFingerprint: text("machine_fingerprint"),
    platform: text("platform"),
    architecture: text("architecture"),
    tokenHash: text("token_hash").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    isDefault: defaultBooleanColumn(),
  },
  (table) => [
    index("runners_user_deletion_index").on(table.userId, table.isDeleted),
    uniqueIndex("runners_active_machine_unique")
      .on(table.machineFingerprint)
      .where(sql`${table.isDeleted} = false`),
    uniqueIndex("runners_active_token_unique")
      .on(table.tokenHash)
      .where(sql`${table.isDeleted} = false`),
    uniqueIndex("runners_user_default_unique")
      .on(table.userId)
      .where(sql`NOT ${table.isDeleted} AND ${table.isDefault}`),
  ],
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    ...ownedAuditColumns(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
    providerCredentialId: text("provider_credential_id")
      .notNull()
      .references(() => providerCredentials.id, { onDelete: "restrict" }),
    provider: providerColumn(),
    providerPricing: text("provider_pricing"),
    model: text("model").notNull(),
    autoCompact: integer("auto_compact", { mode: "boolean" })
      .notNull()
      .default(true),
    activeDurationMs: integer("active_duration_ms").notNull().default(0),
    activeStartedAt: integer("active_started_at", { mode: "timestamp_ms" }),
    costBasis: text("cost_basis", {
      enum: ["none", "reported", "estimated"],
    })
      .notNull()
      .default("none"),
    costUsd: real("cost_usd").notNull().default(0),
    currentContextTokens: integer("current_context_tokens")
      .notNull()
      .default(0),
    maxContextTokens: integer("max_context_tokens"),
    agentFileName: text("agent_file_name", { enum: AGENT_FILE_NAMES }),
    agentFileContent: text("agent_file_content"),
    reasoningEffort: text("reasoning_effort", {
      enum: AGENT_REASONING_EFFORTS,
    }),
    workingDirectory: text("working_directory").notNull(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["queued", "running", "idle", "stopped", "failed"],
    }).notNull(),
  },
  (table) => [
    index("agent_sessions_user_deletion_update_index").on(
      table.userId,
      table.isDeleted,
      table.updatedAt,
    ),
    index("agent_sessions_runner_status_index").on(
      table.runnerId,
      table.status,
    ),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    ...ownedAuditColumns(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "restrict" }),
    role: text("role", {
      enum: ["user", "assistant", "tool", "thinking", "system"],
    }).notNull(),
    content: text("content").notNull(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolCalls: text("tool_calls"),
    images: text("images"),
  },
  (table) => [
    index("agent_messages_session_deletion_creation_index").on(
      table.sessionId,
      table.isDeleted,
      table.createdAt,
    ),
    index("agent_messages_user_deletion_index").on(
      table.userId,
      table.isDeleted,
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
