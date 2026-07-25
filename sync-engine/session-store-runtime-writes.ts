import { type SQL } from "drizzle-orm";
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
import type { CompactionUsage } from "./session-compaction-usage.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import { runningCondition } from "./session-store-reassignment.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  errorMessageValues,
  recordedMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";
import { runtimeUsageValues } from "./session-usage-values.ts";

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
  options: RuntimeWriteTarget & {
    readonly summary: string;
    readonly usage: CompactionUsage;
  },
): void {
  compactStoredConversation({
    ...runtimeWriteTarget(options),
    summary: options.summary,
    usage: options.usage,
  });
}

export function updateRuntimeUsage(
  options: RuntimeWriteTarget & { readonly input: AgentSessionUsageUpdate },
): void {
  updateRunningSession(options, runtimeUsageValues(options.input));
}

function messageValues(
  messages: readonly AgentRecordedMessage[],
): readonly StoredMessageValues[] {
  return messages.map(recordedMessageValues);
}

function touchSessionWithMessages(options: {
  readonly condition: SQL | undefined;
  readonly messages: readonly StoredMessageValues[];
  readonly target: RuntimeWriteTarget;
}): void {
  options.target.resources.database.transaction((transaction) => {
    const userId = requireRunningSessionUserId(transaction, options.condition);

    for (const message of options.messages) {
      appendSystemStoredMessage({
        database: transaction,
        generateId: options.target.resources.generateId,
        message,
        now: options.target.now,
        sessionId: options.target.sessionId,
        userId,
      });
    }
    transaction
      .update(agentSessions)
      .set(updatedAuditFields(SYSTEM_ID, options.target.now))
      .where(options.condition)
      .run();
  });
}

function appendRuntimeMessages(
  options: RuntimeWriteTarget & {
    readonly messages: readonly StoredMessageValues[];
  },
): void {
  const condition = runningSessionCondition(options);
  touchSessionWithMessages({
    condition,
    messages: options.messages,
    target: options,
  });
}

export function appendRuntimeAgentMessages(
  options: RuntimeWriteTarget & {
    readonly messages: readonly AgentRecordedMessage[];
    readonly usage?: AgentSessionUsageUpdate;
  },
): void {
  const storedMessages = messageValues(options.messages);
  if (options.usage === undefined) {
    appendRuntimeMessages({ ...options, messages: storedMessages });
    return;
  }

  const condition = runningSessionCondition(options);
  const usageValues = runtimeUsageValues(options.usage);
  options.resources.database.transaction((transaction) => {
    const userId = requireRunningSessionUserId(transaction, condition);
    for (const message of storedMessages) {
      appendSystemStoredMessage({
        database: transaction,
        generateId: options.resources.generateId,
        message,
        now: options.now,
        sessionId: options.sessionId,
        userId,
      });
    }
    transaction
      .update(agentSessions)
      .set({ ...usageValues, ...updatedAuditFields(SYSTEM_ID, options.now) })
      .where(condition)
      .run();
  });
}

export function appendRuntimeErrorMessage(
  options: RuntimeWriteTarget & { readonly content: string },
): void {
  appendRuntimeMessages({
    ...options,
    messages: [errorMessageValues(options.content)],
  });
}
