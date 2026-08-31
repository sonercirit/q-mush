import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { AGENT_ATTACHMENT_MODALITIES } from "../agent-attachments.ts";
import { AGENT_REASONING_EFFORTS } from "../agent-configuration.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../agent-tools.ts";
import {
  AGENT_SESSION_MESSAGE_ROLES,
  AGENT_SESSION_STATUSES,
} from "../session-model.ts";
import { auditColumns } from "./audit-columns.ts";
import { identityAndCredentialTables } from "./identity-schema.ts";
import { connectionColumns, providerColumn } from "./provider-columns.ts";
import {
  activeDefaultIndex,
  ownedAuditColumns,
  ownedForeignKey,
  sessionContextColumns,
  tokenUsageColumns,
} from "./schema-columns.ts";
import { agentSessionTables } from "./session-operation-schema.ts";
import { createToolSettingsTable } from "./tool-settings-schema.ts";
export { auditColumns } from "./audit-columns.ts";

export const { prompts, providerCredentials, users, workspaces } =
  identityAndCredentialTables();

function userIdColumn() {
  return ownedForeignKey("user_id", () => users.id);
}

const userOwnedAuditColumns = () => ownedAuditColumns(() => users.id);
export const toolSettings = createToolSettingsTable(() => users.id);
const runnerDefault = activeDefaultIndex("runners_user_default_unique");

function workspaceIdColumn() {
  return ownedForeignKey("workspace_id", () => workspaces.id);
}

function providerCredentialIdColumn() {
  return ownedForeignKey(
    "provider_credential_id",
    () => providerCredentials.id,
  );
}
function quotaIndex(table: {
  readonly isDeleted: AnySQLiteColumn;
  readonly providerCredentialId: AnySQLiteColumn;
}) {
  return uniqueIndex("provider_quota_settings_active_credential_unique")
    .on(table.providerCredentialId)
    .where(sql`NOT ${table.isDeleted}`);
}
function threshold() {
  return real("auto_reset_threshold_percent").notNull().default(1);
}
export const providerQuotaSettings = sqliteTable(
  "provider_quota_settings",
  {
    ...userOwnedAuditColumns(),
    providerCredentialId: providerCredentialIdColumn(),
    autoResetThresholdPercent: threshold(),
  },
  (table) => [
    index("provider_quota_settings_user_id_index").on(table.userId, table.id),
    index("provider_quota_settings_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    quotaIndex(table),
    check(
      "provider_quota_settings_threshold_range_check",
      sql`${table.autoResetThresholdPercent} >= 0 AND ${table.autoResetThresholdPercent} <= 100`,
    ),
  ],
);
export const providerQuotaResetReceipts = sqliteTable(
  "provider_quota_reset_receipts",
  {
    ...userOwnedAuditColumns(),
    providerCredentialId: providerCredentialIdColumn(),
    clientRequestId: text("client_request_id").notNull(),
    outcome: text("outcome", {
      enum: ["already_redeemed", "no_credit", "nothing_to_reset", "reset"],
    }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("provider_quota_reset_receipts_user_id_index").on(
      table.userId,
      table.id,
    ),
    index("provider_quota_reset_receipts_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    uniqueIndex("provider_quota_reset_receipts_active_request_unique")
      .on(table.userId, table.providerCredentialId, table.clientRequestId)
      .where(sql`NOT ${table.isDeleted}`),
    uniqueIndex("provider_quota_reset_receipts_pending_credential_unique")
      .on(table.providerCredentialId)
      .where(sql`NOT ${table.isDeleted} AND ${table.outcome} IS NULL`),
  ],
);
function activeConnectionIndex(
  name: string,
  ownerId: AnySQLiteColumn,
  workspaceId: AnySQLiteColumn,
  isDeleted: AnySQLiteColumn,
) {
  return uniqueIndex(name)
    .on(ownerId, workspaceId)
    .where(sql`NOT ${isDeleted}`);
}
export const providerCredentialWorkspaces = sqliteTable(
  "provider_credential_workspaces",
  {
    ...userOwnedAuditColumns(),
    providerCredentialId: providerCredentialIdColumn(),
    workspaceId: workspaceIdColumn(),
  },
  (table) => [
    index("provider_credential_workspaces_user_id_index").on(
      table.userId,
      table.id,
    ),
    index("provider_credential_workspaces_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    activeConnectionIndex(
      "provider_credential_workspaces_active_unique",
      table.providerCredentialId,
      table.workspaceId,
      table.isDeleted,
    ),
  ],
);
export const attachmentFallbacks = sqliteTable(
  "attachment_fallbacks",
  {
    ...userOwnedAuditColumns(),
    modality: text("modality", { enum: AGENT_ATTACHMENT_MODALITIES }).notNull(),
    providerCredentialId: providerCredentialIdColumn(),
    provider: providerColumn(),
    model: text("model").notNull(),
    openRouterProviderTag: text("openrouter_provider_tag"),
  },
  (table) => [
    index("attachment_fallbacks_user_id_index").on(table.userId, table.id),
    index("attachment_fallbacks_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    uniqueIndex("attachment_fallbacks_user_modality_active_unique")
      .on(table.userId, table.modality)
      .where(sql`NOT ${table.isDeleted}`),
  ],
);
export const runners = sqliteTable(
  "runners",
  {
    ...userOwnedAuditColumns(),
    name: text("name"),
    machineFingerprint: text("machine_fingerprint"),
    platform: text("platform"),
    architecture: text("architecture"),
    tokenHash: text("token_hash").notNull(),
    tokenDigest: text("token_digest").notNull().default(""),
    activationGeneration: integer("activation_generation").notNull().default(0),
    activationId: text("activation_id"),
    activationPhase: text("activation_phase", {
      enum: ["prepared", "finalized"],
    }),
    activationRestartId: text("activation_restart_id"),
    activationLifecycle: text("activation_lifecycle", {
      enum: ["ordinary", "restart"],
    }),
    activationLifecycleSettled: integer("activation_lifecycle_settled", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    activationSourceId: text("activation_source_id"),
    activationTargetId: text("activation_target_id"),
    activationTargetGeneration: integer("activation_target_generation"),
    activationReservationId: text("activation_reservation_id"),
    activationReservationGeneration: integer(
      "activation_reservation_generation",
    ),
    activationReservationSourceId: text("activation_reservation_source_id"),
    activationMachineFingerprint: text("activation_machine_fingerprint"),
    activationPlatform: text("activation_platform"),
    activationArchitecture: text("activation_architecture"),
    activationName: text("activation_name"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    ...connectionColumns(),
  },
  (table) => [
    index("runners_user_id_index").on(table.userId, table.id),
    index("runners_user_deletion_index").on(table.userId, table.isDeleted),
    uniqueIndex("runners_active_machine_unique")
      .on(table.machineFingerprint)
      .where(sql`${table.isDeleted} = false`),
    uniqueIndex("runners_active_token_digest_unique")
      .on(table.tokenDigest)
      .where(sql`${table.isDeleted} = false AND ${table.tokenDigest} <> ''`),
    uniqueIndex("runners_active_activation_id_unique")
      .on(table.activationId)
      .where(
        sql`${table.isDeleted} = false AND ${table.activationId} IS NOT NULL`,
      ),
    uniqueIndex("runners_active_token_unique")
      .on(table.tokenHash)
      .where(sql`${table.isDeleted} = false`),
    runnerDefault(table),
    check(
      "runners_activation_generation_nonnegative_check",
      sql`${table.activationGeneration} >= 0`,
    ),
    check(
      "runners_activation_phase_identity_check",
      sql`(${table.activationPhase} IS NULL AND ${table.activationId} IS NULL AND ${table.activationLifecycle} IS NULL) OR (${table.activationPhase} IS NOT NULL AND ${table.activationPhase} IN ('prepared', 'finalized') AND ${table.activationId} IS NOT NULL AND ${table.activationLifecycle} IS NOT NULL AND ${table.activationLifecycle} IN ('ordinary', 'restart'))`,
    ),
    check(
      "runners_activation_settlement_identity_check",
      sql`${table.activationPhase} IS NOT NULL OR NOT ${table.activationLifecycleSettled}`,
    ),
    check(
      "runners_activation_lifecycle_restart_check",
      sql`(${table.activationLifecycle} IS NULL AND ${table.activationRestartId} IS NULL) OR (${table.activationLifecycle} IS NOT NULL AND ${table.activationLifecycle} = 'ordinary' AND ${table.activationRestartId} IS NULL) OR (${table.activationLifecycle} IS NOT NULL AND ${table.activationLifecycle} = 'restart' AND ${table.activationRestartId} IS NOT NULL)`,
    ),
    check(
      "runners_activation_scope_check",
      sql`(${table.activationPhase} IS NULL AND ${table.activationSourceId} IS NULL AND ${table.activationTargetId} IS NULL AND ${table.activationTargetGeneration} IS NULL AND ${table.activationMachineFingerprint} IS NULL AND ${table.activationPlatform} IS NULL AND ${table.activationArchitecture} IS NULL AND ${table.activationName} IS NULL) OR (${table.activationPhase} IS NOT NULL AND ${table.activationSourceId} IS NOT NULL AND ${table.activationTargetId} IS NOT NULL AND ${table.activationTargetGeneration} IS NOT NULL AND ${table.activationTargetGeneration} >= 0 AND ${table.activationMachineFingerprint} IS NOT NULL AND ${table.activationPlatform} IS NOT NULL AND ${table.activationArchitecture} IS NOT NULL AND ${table.activationName} IS NOT NULL)`,
    ),
    check(
      "runners_activation_reservation_check",
      sql`(${table.activationReservationId} IS NULL AND ${table.activationReservationGeneration} IS NULL AND ${table.activationReservationSourceId} IS NULL) OR (${table.activationReservationId} IS NOT NULL AND ${table.activationReservationGeneration} IS NOT NULL AND ${table.activationReservationGeneration} >= 0 AND ${table.activationReservationSourceId} IS NOT NULL)`,
    ),
    check(
      "runners_activation_settled_finalized_check",
      sql`NOT ${table.activationLifecycleSettled} OR ${table.activationPhase} = 'finalized'`,
    ),
  ],
);
export const runnerWorkspaces = sqliteTable(
  "runner_workspaces",
  {
    ...userOwnedAuditColumns(),
    runnerId: ownedForeignKey("runner_id", () => runners.id),
    workspaceId: workspaceIdColumn(),
  },
  (table) => [
    index("runner_workspaces_user_id_index").on(table.userId, table.id),
    index("runner_workspaces_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    activeConnectionIndex(
      "runner_workspaces_active_unique",
      table.runnerId,
      table.workspaceId,
      table.isDeleted,
    ),
  ],
);
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    ...userOwnedAuditColumns(),
    workspaceId: workspaceIdColumn(),
    parentSessionId: text("parent_session_id"),
    parentExecutionGeneration: integer("parent_execution_generation"),
    parentCallbackGeneration: integer("parent_callback_generation"),
    spawnPreparationPending: integer("spawn_preparation_pending", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    parentReportedGeneration: integer("parent_reported_generation")
      .notNull()
      .default(-1),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "restrict" }),
    runnerRequired: integer("runner_required", { mode: "boolean" })
      .notNull()
      .default(false),
    executionGeneration: integer("execution_generation").notNull().default(0),
    currentSegment: integer("current_segment").notNull().default(0),
    restartHandoff: text("restart_handoff"),
    interruptedHandoff: text("shutdown_interrupted_handoff"),
    providerCredentialId: text("provider_credential_id")
      .notNull()
      .references(() => providerCredentials.id, { onDelete: "restrict" }),
    provider: providerColumn(),
    providerPricing: text("provider_pricing"),
    openRouterProviderTag: text("openrouter_provider_tag"),
    model: text("model").notNull(),
    autoCompact: integer("auto_compact", { mode: "boolean" })
      .notNull()
      .default(true),
    idleCompact: integer("idle_compact", { mode: "boolean" })
      .notNull()
      .default(false),
    activeDurationMs: integer("active_duration_ms").notNull().default(0),
    activeStartedAt: integer("active_started_at", { mode: "timestamp_ms" }),
    stepStartedAt: integer("step_started_at", { mode: "timestamp_ms" }),
    costBasis: text("cost_basis", {
      enum: ["none", "reported", "estimated"],
    })
      .notNull()
      .default("none"),
    costUsd: real("cost_usd").notNull().default(0),
    ...sessionContextColumns(),
    adaptiveThinking: integer("adaptive_thinking", { mode: "boolean" }),
    agentFilePath: text("agent_file_path"),
    agentFileName: text("agent_file_name"),
    agentFileContent: text("agent_file_content"),
    reasoningEffort: text("reasoning_effort", {
      enum: AGENT_REASONING_EFFORTS,
    }),
    executionEnvironment: text("execution_environment", {
      enum: ["bare_metal", "container"],
    })
      .notNull()
      .default("bare_metal"),
    workingDirectory: text("working_directory").notNull(),
    title: text("title").notNull(),
    tools: text("tools")
      .notNull()
      .default(JSON.stringify(AGENT_SESSION_TOOL_NAMES)),
    status: text("status", { enum: AGENT_SESSION_STATUSES }).notNull(),
  },
  (table) => [
    index("agent_sessions_user_id_index").on(table.userId, table.id),
    check(
      "agent_sessions_current_segment_nonnegative_check",
      sql`${table.currentSegment} >= 0`,
    ),
    index("agent_sessions_user_workspace_deletion_update_index").on(
      table.userId,
      table.workspaceId,
      table.isDeleted,
      table.updatedAt,
    ),
    index("agent_sessions_parent_report_index").on(
      table.status,
      table.parentSessionId,
      table.parentExecutionGeneration,
      table.parentReportedGeneration,
    ),
    index("agent_sessions_runner_status_index").on(
      table.runnerId,
      table.status,
    ),
    index("agent_sessions_parent_owner_deletion_index").on(
      table.parentSessionId,
      table.userId,
      table.isDeleted,
    ),
  ],
);
function agentSessionIdColumn() {
  const column = text("session_id").notNull();
  return column.references(() => agentSessions.id, { onDelete: "restrict" });
}
export const { agentSessionOperations, agentSessionTurns } = agentSessionTables(
  () => users.id,
  () => agentSessions.id,
);
export const agentPendingInputs = sqliteTable(
  "agent_pending_inputs",
  {
    ...userOwnedAuditColumns(),
    sessionId: agentSessionIdColumn(),
    clientRequestId: text("client_request_id").notNull(),
    kind: text("kind", { enum: ["follow_up", "steer"] }).notNull(),
    content: text("content").notNull(),
    images: text("images"),
    sequence: integer("sequence").notNull(),
  },
  (table) => [
    index("agent_pending_inputs_user_id_index").on(table.userId, table.id),
    index("agent_pending_inputs_session_deletion_sequence_index").on(
      table.sessionId,
      table.isDeleted,
      table.sequence,
    ),
    uniqueIndex("agent_pending_inputs_session_sequence_unique").on(
      table.sessionId,
      table.sequence,
    ),
    uniqueIndex("agent_pending_inputs_user_request_unique").on(
      table.userId,
      table.clientRequestId,
    ),
  ],
);
export const agentQuestionRequests = sqliteTable(
  "agent_question_requests",
  {
    ...userOwnedAuditColumns(),
    sessionId: agentSessionIdColumn(),
    toolCallId: text("tool_call_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    questions: text("questions").notNull(),
    answers: text("answers"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("agent_question_requests_user_id_index").on(table.userId, table.id),
    index("agent_question_requests_session_deletion_index").on(
      table.sessionId,
      table.isDeleted,
    ),
    index("agent_question_requests_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    uniqueIndex("agent_question_requests_session_tool_call_unique").on(
      table.sessionId,
      table.toolCallId,
    ),
    uniqueIndex("agent_question_requests_active_session_unique")
      .on(table.sessionId)
      .where(sql`${table.answeredAt} IS NULL AND NOT ${table.isDeleted}`),
    check(
      "agent_question_requests_generation_nonnegative_check",
      sql`${table.executionGeneration} >= 0`,
    ),
  ],
);
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    ...userOwnedAuditColumns(),
    sessionId: agentSessionIdColumn(),
    turnId: text("turn_id").references(() => agentSessionTurns.id, {
      onDelete: "restrict",
    }),
    segment: integer("segment").notNull().default(0),
    role: text("role", { enum: AGENT_SESSION_MESSAGE_ROLES }).notNull(),
    content: text("content").notNull(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolCalls: text("tool_calls"),
    providerReplay: text("provider_replay"),
    images: text("images"),
    ...tokenUsageColumns(),
  },
  (table) => [
    index("agent_messages_user_id_index").on(table.userId, table.id),
    index("agent_messages_session_deletion_creation_index").on(
      table.sessionId,
      table.isDeleted,
      table.createdAt,
    ),
    index("agent_messages_session_segment_creation_index").on(
      table.sessionId,
      table.segment,
      table.createdAt,
    ),
    index("agent_messages_turn_index").on(table.turnId),
    index("agent_messages_user_deletion_index").on(
      table.userId,
      table.isDeleted,
    ),
    check(
      "agent_messages_segment_nonnegative_check",
      sql`${table.segment} >= 0`,
    ),
  ],
);
const operationPartitionColumn = () =>
  text("partition", { enum: ["non-session", "session"] }).notNull();
export const operationEnvelopes = sqliteTable(
  "operation_envelopes",
  {
    ...userOwnedAuditColumns(),
    partition: operationPartitionColumn(),
    writerId: text("writer_id").notNull(),
    sequence: text("sequence").notNull(),
    sequenceOrder: text("sequence_order").notNull().default(""),
    operationId: text("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    encodedEnvelope: text("encoded_envelope").notNull(),
  },
  (table) => [
    uniqueIndex("operation_envelopes_active_writer_sequence_unique")
      .on(table.userId, table.partition, table.writerId, table.sequence)
      .where(sql`NOT ${table.isDeleted}`),
    uniqueIndex("operation_envelopes_active_operation_id_unique")
      .on(table.userId, table.partition, table.operationId)
      .where(sql`NOT ${table.isDeleted}`),
    index("operation_envelopes_owner_partition_writer_index").on(
      table.userId,
      table.partition,
      table.isDeleted,
      table.writerId,
      table.sequenceOrder,
    ),
  ],
);
export const operationCheckpoints = sqliteTable(
  "operation_checkpoints",
  {
    ...userOwnedAuditColumns(),
    partition: operationPartitionColumn(),
    encodedCheckpoint: text("encoded_checkpoint").notNull(),
    stableClock: text("stable_clock"),
    stableFrontier: text("stable_frontier"),
  },
  (table) => [
    uniqueIndex("operation_checkpoints_active_owner_partition_unique")
      .on(table.userId, table.partition)
      .where(sql`NOT ${table.isDeleted}`),
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
