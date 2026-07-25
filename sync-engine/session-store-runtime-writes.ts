import { sql, type SQL } from "drizzle-orm";
import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type {
  AgentSessionCostBasis,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import { runningCondition } from "./session-store-reassignment.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemMessageAndTouchSession,
  errorMessageValues,
  recordedMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";

interface SessionRuntimeWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

interface RuntimeWriteTarget {
  readonly generation: number;
  readonly now: number;
  readonly resources: SessionRuntimeWriteResources;
  readonly sessionId: string;
}

function runtimeWriteTarget(options: RuntimeWriteTarget) {
  return {
    database: options.resources.database,
    generateId: options.resources.generateId,
    generation: options.generation,
    now: options.now,
    sessionId: options.sessionId,
  };
}

function runningSessionCondition(options: RuntimeWriteTarget) {
  return runningCondition(options.sessionId, undefined, options.generation);
}

function updateRunningSession(
  options: RuntimeWriteTarget,
  values: Omit<
    Partial<typeof agentSessions.$inferInsert>,
    "costBasis" | "costUsd"
  > & {
    readonly costBasis?: AgentSessionCostBasis | SQL;
    readonly costUsd?: number | SQL;
    readonly executionGeneration?: number | SQL;
  },
): void {
  options.resources.database
    .update(agentSessions)
    .set({ ...values, ...updatedAuditFields(SYSTEM_ID, options.now) })
    .where(runningSessionCondition(options))
    .run();
}

export function setRuntimeAgentFile(
  options: RuntimeWriteTarget & { readonly agentFile: AgentFile | null },
): void {
  updateRunningSession(options, {
    agentFileContent: options.agentFile?.content ?? null,
    agentFileName: options.agentFile?.name ?? null,
  });
}

export function compactRuntimeConversation(
  options: RuntimeWriteTarget & { readonly summary: string },
): void {
  compactStoredConversation({
    ...runtimeWriteTarget(options),
    summary: options.summary,
  });
}

export function updateRuntimeUsage(
  options: RuntimeWriteTarget & { readonly input: AgentSessionUsageUpdate },
): void {
  const invalidCost =
    (options.input.costUsd === null) !== (options.input.costBasis === null) ||
    (options.input.costUsd !== null &&
      (!Number.isFinite(options.input.costUsd) || options.input.costUsd < 0));
  if (
    (options.input.contextTokens !== null &&
      (!Number.isSafeInteger(options.input.contextTokens) ||
        options.input.contextTokens < 0)) ||
    invalidCost
  ) {
    throw new Error("The agent session usage is invalid");
  }

  updateRunningSession(options, {
    ...(options.input.contextTokens === null
      ? {}
      : { currentContextTokens: options.input.contextTokens }),
    ...(options.input.costUsd === null
      ? {}
      : {
          costBasis:
            options.input.costBasis === "estimated"
              ? "estimated"
              : sql`CASE WHEN ${agentSessions.costBasis} = 'none' THEN 'reported' ELSE ${agentSessions.costBasis} END`,
          costUsd: sql`${agentSessions.costUsd} + ${options.input.costUsd}`,
        }),
  });
}

function touchSessionWithMessage(options: {
  readonly condition: SQL | undefined;
  readonly message: StoredMessageValues;
  readonly target: RuntimeWriteTarget;
}): void {
  options.target.resources.database.transaction((transaction) => {
    const userId = requireRunningSessionUserId(transaction, options.condition);

    appendSystemMessageAndTouchSession({
      condition: options.condition,
      database: transaction,
      generateId: options.target.resources.generateId,
      message: options.message,
      now: options.target.now,
      sessionId: options.target.sessionId,
      userId,
    });
  });
}

function appendRuntimeMessage(
  options: RuntimeWriteTarget & { readonly message: StoredMessageValues },
): void {
  const condition = runningSessionCondition(options);
  touchSessionWithMessage({
    condition,
    message: options.message,
    target: options,
  });
}

export function appendRuntimeAgentMessage(
  options: RuntimeWriteTarget & { readonly message: AgentRecordedMessage },
): void {
  appendRuntimeMessage({
    ...options,
    message: recordedMessageValues(options.message),
  });
}

export function appendRuntimeErrorMessage(
  options: RuntimeWriteTarget & { readonly content: string },
): void {
  appendRuntimeMessage({
    ...options,
    message: errorMessageValues(options.content),
  });
}
