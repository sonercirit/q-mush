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
  RestartHandoff,
} from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import { storedRecordedMessages } from "./session-message-values.ts";
import { runningCondition } from "./session-store-persistence.ts";
import { requireRunningSessionUserId } from "./session-store-state.ts";
import type { SessionRuntimeTarget } from "./session-store-types.ts";
import {
  appendSystemStoredMessage,
  errorMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";
import {
  settleTerminalRuntime,
  terminalRuntimeCondition,
} from "./session-terminal-store.ts";
import { runtimeUsageValues } from "./session-usage-values.ts";

interface SessionRuntimeWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

type RuntimeWriteTarget = SessionRuntimeTarget<SessionRuntimeWriteResources>;

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

function compactRuntime(
  options: RuntimeWriteTarget & {
    readonly restartHandoff?: RestartHandoff | null;
    readonly summary: string;
    readonly usage: CompactionUsage;
  },
  settle: boolean,
): void {
  compactStoredConversation({
    ...runtimeWriteTarget(options),
    ...(options.restartHandoff === undefined
      ? {}
      : { restartHandoff: options.restartHandoff }),
    ...(settle ? { settle: true } : {}),
    summary: options.summary,
    usage: options.usage,
  });
}

export function compactRuntimeTerminal(
  options: Parameters<typeof compactRuntime>[0],
): void {
  compactRuntime(options, true);
}

export function compactRuntimeConversation(
  options: Omit<Parameters<typeof compactRuntime>[0], "restartHandoff">,
): void {
  compactRuntime(options, false);
}

export function updateRuntimeUsage(
  options: RuntimeWriteTarget & { readonly input: AgentSessionUsageUpdate },
): void {
  updateRunningSession(options, runtimeUsageValues(options.input));
}

function appendStoredMessages(
  transaction: Pick<AppDatabase, "insert" | "select">,
  options: RuntimeWriteTarget,
  condition: SQL | undefined,
  messages: readonly StoredMessageValues[],
): string {
  const userId = requireRunningSessionUserId(transaction, condition);
  for (const message of messages) {
    appendSystemStoredMessage({
      database: transaction,
      generateId: options.resources.generateId,
      message,
      now: options.now,
      sessionId: options.sessionId,
      userId,
    });
  }
  return userId;
}

function touchSessionWithMessages(options: {
  readonly condition: SQL | undefined;
  readonly messages: readonly StoredMessageValues[];
  readonly target: RuntimeWriteTarget;
}): void {
  options.target.resources.database.transaction((transaction) => {
    appendStoredMessages(
      transaction,
      options.target,
      options.condition,
      options.messages,
    );
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

function updateSessionWithUsage(
  database: Pick<AppDatabase, "update">,
  condition: SQL | undefined,
  values: ReturnType<typeof runtimeUsageValues>,
): void {
  database.update(agentSessions).set(values).where(condition).run();
}

function writeStoredMessages(
  options: RuntimeWriteTarget,
  condition: SQL | undefined,
  storedMessages: readonly StoredMessageValues[],
  after: (
    transaction: Pick<AppDatabase, "insert" | "select" | "update">,
  ) => void,
): void {
  options.resources.database.transaction((transaction) => {
    appendStoredMessages(transaction, options, condition, storedMessages);
    after(transaction);
  });
}

export function commitRuntimeTerminal(
  options: RuntimeWriteTarget & {
    readonly messages: readonly AgentRecordedMessage[];
    readonly restartHandoff: RestartHandoff | null;
    readonly usage?: AgentSessionUsageUpdate;
  },
): void {
  const condition = terminalRuntimeCondition({
    generation: options.generation,
    restartHandoff: options.restartHandoff,
    sessionId: options.sessionId,
  });
  const storedMessages = storedRecordedMessages(options.messages);
  writeStoredMessages(options, condition, storedMessages, (transaction) => {
    if (options.usage !== undefined) {
      updateSessionWithUsage(
        transaction,
        condition,
        runtimeUsageValues(options.usage),
      );
    }
    settleTerminalRuntime(
      transaction,
      condition,
      "idle",
      options.now,
      options.sessionId,
    );
  });
}

export function appendRuntimeAgentMessages(
  options: RuntimeWriteTarget & {
    readonly messages: readonly AgentRecordedMessage[];
    readonly usage?: AgentSessionUsageUpdate;
  },
): void {
  const storedMessages = storedRecordedMessages(options.messages);
  if (options.usage === undefined) {
    appendRuntimeMessages({ ...options, messages: storedMessages });
    return;
  }

  const condition = runningSessionCondition(options);

  const usageValues = runtimeUsageValues(options.usage);
  writeStoredMessages(options, condition, storedMessages, (transaction) => {
    updateSessionWithUsage(transaction, condition, {
      ...usageValues,
      ...updatedAuditFields(SYSTEM_ID, options.now),
    });
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
