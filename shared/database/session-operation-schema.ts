import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  DEFAULT_TOOL_SETTINGS,
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  MINIMUM_TOOL_OUTPUT_CHARACTERS,
} from "../tool-limits.ts";

import { ownedAuditColumns, ownedForeignKey } from "./schema-columns.ts";

export function agentSessionTables(
  userReference: () => AnySQLiteColumn,
  sessionReference: () => AnySQLiteColumn,
) {
  const sessionIdColumn = () => ownedForeignKey("session_id", sessionReference);
  const executionGenerationColumn = () =>
    integer("execution_generation").notNull();
  const agentSessionTurns = sqliteTable(
    "agent_session_turns",
    {
      ...ownedAuditColumns(userReference),
      boundaryMessageId: text("boundary_message_id"),
      endedAt: integer("ended_at", { mode: "timestamp_ms" }),
      executionGeneration: executionGenerationColumn(),
      segment: integer("segment").notNull().default(0),
      sessionId: sessionIdColumn(),
      startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
      toolExecutionLimitMinutes: integer("tool_execution_limit_minutes")
        .notNull()
        .default(DEFAULT_TOOL_SETTINGS.executionLimitMinutes),
      toolOutputLimitCharacters: integer("tool_output_limit_characters")
        .notNull()
        .default(DEFAULT_TOOL_SETTINGS.outputLimitCharacters),
    },
    (table) => [
      index("agent_session_turns_session_segment_start_index").on(
        table.sessionId,
        table.segment,
        table.startedAt,
      ),
      uniqueIndex("agent_session_turns_active_session_unique")
        .on(table.sessionId)
        .where(sql`${table.endedAt} IS NULL AND NOT ${table.isDeleted}`),
      check(
        "agent_session_turns_segment_nonnegative_check",
        sql`${table.segment} >= 0`,
      ),
      check(
        "agent_session_turns_generation_nonnegative_check",
        sql`${table.executionGeneration} >= 0`,
      ),
      check(
        "agent_session_turns_tool_execution_range_check",
        sql`${table.toolExecutionLimitMinutes} >= 1 AND ${table.toolExecutionLimitMinutes} <= ${sql.raw(String(MAXIMUM_TOOL_EXECUTION_MINUTES))}`,
      ),
      check(
        "agent_session_turns_tool_output_range_check",
        sql`${table.toolOutputLimitCharacters} >= ${sql.raw(String(MINIMUM_TOOL_OUTPUT_CHARACTERS))} AND ${table.toolOutputLimitCharacters} <= ${sql.raw(String(MAXIMUM_TOOL_OUTPUT_CHARACTERS))}`,
      ),
      check(
        "agent_session_turns_end_check",
        sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
      ),
    ],
  );
  const agentSessionOperations = sqliteTable(
    "agent_session_operations",
    {
      ...ownedAuditColumns(userReference),
      operation: text("operation", {
        enum: ["compact_and_continue"],
      }).notNull(),
      sessionId: sessionIdColumn(),
      executionGeneration: executionGenerationColumn(),
    },
    (table) => [
      uniqueIndex("agent_session_operations_active_generation_unique")
        .on(table.sessionId, table.executionGeneration)
        .where(sql`NOT ${table.isDeleted}`),
    ],
  );
  return { agentSessionOperations, agentSessionTurns };
}
