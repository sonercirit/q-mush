import { desc, sql, type SQL } from "drizzle-orm";
import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
  AgentRecordedMessage,
} from "../shared/agent-loop.ts";
import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type {
  AgentSessionCostBasis,
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import { storedSessionAgentFile } from "./session-store-agent-file.ts";
import {
  createStoredSession,
  type CreateAgentSession,
  type CreateSessionResult,
} from "./session-store-create.ts";
import {
  queueStoredSession,
  type QueueSessionResult,
} from "./session-store-queue.ts";
import {
  appendInterruptedRunnerToolResult,
  conversationFromMessages,
  parseProviderPricing,
  readStoredSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";
import {
  activeSessionCondition,
  didUpdate,
  interruptedStoredSessions,
  reassignStoredSession,
  runningCondition,
  SESSION_TIMING_SELECTION,
  sessionGenerationCondition,
  sessionTimingUpdate,
  transitionStoredSession,
  updateStoredSession,
  type ReassignSessionResult,
  type SessionFilter,
} from "./session-store-reassignment.ts";
import {
  appendSpawnedSessionReport,
  parentSessionId,
  pendingSpawnedSessions,
  type PendingSpawnedSession,
} from "./session-store-spawns.ts";
import {
  appendSessionUserMessage,
  errorMessageValues,
  insertStoredMessage,
  interruptedSessionErrorValues,
  recordedMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";

function requireStoredSession<Value>(stored: Value | undefined): Value {
  if (stored === undefined) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
  return stored;
}

function sessionSelection() {
  return {
    activeDurationMs: agentSessions.activeDurationMs,
    activeStartedAt: agentSessions.activeStartedAt,
    autoCompact: agentSessions.autoCompact,
    costBasis: agentSessions.costBasis,
    costUsd: agentSessions.costUsd,
    createdAt: agentSessions.createdAt,
    credentialId: agentSessions.providerCredentialId,
    currentContextTokens: agentSessions.currentContextTokens,
    executionGeneration: agentSessions.executionGeneration,
    id: agentSessions.id,
    maxContextTokens: agentSessions.maxContextTokens,
    model: agentSessions.model,
    provider: agentSessions.provider,
    providerPricing: agentSessions.providerPricing,
    reasoningEffort: agentSessions.reasoningEffort,
    runnerId: agentSessions.runnerId,
    runnerRequired: agentSessions.runnerRequired,
    status: agentSessions.status,
    title: agentSessions.title,
    tools: agentSessions.tools,
    updatedAt: agentSessions.updatedAt,
    workingDirectory: agentSessions.workingDirectory,
  };
}

type StoredSessionSummary = Pick<
  typeof agentSessions.$inferSelect,
  | "activeDurationMs"
  | "activeStartedAt"
  | "autoCompact"
  | "costBasis"
  | "costUsd"
  | "createdAt"
  | "currentContextTokens"
  | "executionGeneration"
  | "id"
  | "maxContextTokens"
  | "model"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "runnerId"
  | "runnerRequired"
  | "status"
  | "title"
  | "tools"
  | "updatedAt"
  | "workingDirectory"
> & { readonly credentialId: string };

function parseStoredTools(value: string): readonly AgentSessionToolName[] {
  try {
    const tools = readAgentSessionToolNames(JSON.parse(value));
    if (tools !== undefined) {
      return tools;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent session tools are invalid");
}

function summarizeSession(stored: StoredSessionSummary): AgentSessionSummary {
  const { executionGeneration: generation, ...summary } = stored;
  return {
    ...summary,
    generation,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerPricing: parseProviderPricing(stored.providerPricing),
    tools: parseStoredTools(stored.tools),
    updatedAt: stored.updatedAt.getTime(),
  };
}

export class SessionStore {
  readonly #resources: readonly [AppDatabase, IdGenerator];

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#resources = [database, generateId];
  }

  get #database(): AppDatabase {
    return this.#resources[0];
  }

  #generateId(now: number): string {
    return this.#resources[1](now);
  }

  create(input: CreateAgentSession, now: number): CreateSessionResult {
    return createStoredSession(
      {
        database: this.#database,
        generateId: this.#resources[1],
        read: (userId, sessionId) => this.get(userId, sessionId),
      },
      input,
      now,
    );
  }
  executionIsCurrent(sessionId: string, generation: number): boolean {
    return (
      this.#database
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(
          sessionGenerationCondition(
            { id: sessionId, status: "running" },
            generation,
          ),
        )
        .get() !== undefined
    );
  }

  get(userId: string, sessionId: string): AgentSessionDetail | undefined {
    const stored = this.#selectSessions({ id: sessionId, userId }).get();
    if (stored === undefined) {
      return undefined;
    }

    return {
      ...summarizeSession(stored),
      agentFile: storedSessionAgentFile(this.#database, sessionId),
      messages: withInterruptedToolResults(
        readStoredSessionMessages(this.#database, sessionId),
        stored.status !== "queued" && stored.status !== "running",
      ),
    };
  }
  list(userId: string): readonly AgentSessionSummary[] {
    return this.#selectSessions({ userId })
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
      .all()
      .map(summarizeSession);
  }

  conversation(sessionId: string): readonly AgentConversationMessage[] {
    return conversationFromMessages(
      withInterruptedToolResults(
        readStoredSessionMessages(this.#database, sessionId),
        true,
      ),
    );
  }
  #updateRunningSession(
    sessionId: string,
    values: Omit<
      Partial<typeof agentSessions.$inferInsert>,
      "costBasis" | "costUsd"
    > & {
      readonly costBasis?: AgentSessionCostBasis | SQL;
      readonly costUsd?: number | SQL;
      readonly executionGeneration?: number | SQL;
    },
    now: number,
    generation?: number,
  ): void {
    this.#database
      .update(agentSessions)
      .set({ ...values, ...updatedAuditFields(SYSTEM_ID, now) })
      .where(runningCondition(sessionId, undefined, generation))
      .run();
  }

  setAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
    generation?: number,
  ): void {
    this.#updateRunningSession(
      sessionId,
      {
        agentFileContent: agentFile?.content ?? null,
        agentFileName: agentFile?.name ?? null,
      },
      now,
      generation,
    );
  }

  compact(
    sessionId: string,
    summary: string,
    now: number,
    generation?: number,
  ): void {
    compactStoredConversation({
      database: this.#database,
      generateId: (timestamp) => this.#generateId(timestamp),
      ...(generation === undefined ? {} : { generation }),
      now,
      sessionId,
      summary,
    });
  }

  reassign(
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    now: number,
  ): ReassignSessionResult {
    return reassignStoredSession({
      database: this.#database,
      now,
      read: (ownerId, id) => this.get(ownerId, id),
      runnerId,
      sessionId,
      userId,
      workingDirectory,
    });
  }

  setAutoCompact(
    userId: string,
    sessionId: string,
    autoCompact: boolean,
    now: number,
  ): AgentSessionDetail | undefined {
    const updated = this.#database
      .update(agentSessions)
      .set({ autoCompact, ...updatedAuditFields(userId, now) })
      .where(activeSessionCondition({ id: sessionId, userId }))
      .returning({ id: agentSessions.id })
      .all();
    return updated[0] === undefined
      ? undefined
      : this.get(userId, updated[0].id);
  }

  updateUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
    generation?: number,
  ): void {
    const invalidCost =
      (input.costUsd === null) !== (input.costBasis === null) ||
      (input.costUsd !== null &&
        (!Number.isFinite(input.costUsd) || input.costUsd < 0));
    if (
      (input.contextTokens !== null &&
        (!Number.isSafeInteger(input.contextTokens) ||
          input.contextTokens < 0)) ||
      invalidCost
    ) {
      throw new Error("The agent session usage is invalid");
    }

    this.#updateRunningSession(
      sessionId,
      {
        ...(input.contextTokens === null
          ? {}
          : { currentContextTokens: input.contextTokens }),
        ...(input.costUsd === null
          ? {}
          : {
              costBasis:
                input.costBasis === "estimated"
                  ? "estimated"
                  : sql`CASE WHEN ${agentSessions.costBasis} = 'none' THEN 'reported' ELSE ${agentSessions.costBasis} END`,
              costUsd: sql`${agentSessions.costUsd} + ${input.costUsd}`,
            }),
      },
      now,
      generation,
    );
  }

  appendAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
    generation?: number,
  ): void {
    const stored = recordedMessageValues(message);
    this.#appendSystemMessage(sessionId, stored, now, generation);
  }

  appendErrorMessage(
    sessionId: string,
    content: string,
    now: number,
    generation?: number,
  ): void {
    const error = errorMessageValues(content);
    this.#appendSystemMessage(sessionId, error, now, generation);
  }

  appendInterruptedRunnerTool(sessionId: string, now: number): void {
    appendInterruptedRunnerToolResult({
      database: this.#database,
      generateId: this.#resources[1],
      now,
      sessionId,
    });
  }

  appendUserMessage(
    userId: string,
    sessionId: string,
    content: string,
    now: number,
  ): boolean {
    return appendSessionUserMessage({
      content,
      now,
      resources: { database: this.#database, generateId: this.#resources[1] },
      sessionId,
      userId,
    });
  }

  appendSpawnedSessionReport(
    userId: string,
    childId: string,
    parentId: string,
    content: string,
    now: number,
  ): boolean {
    return appendSpawnedSessionReport({
      childId,
      content,
      database: this.#database,
      generateId: this.#resources[1],
      now,
      parentId,
      userId,
    });
  }

  parentSessionId(userId: string, sessionId: string): string | undefined {
    return parentSessionId(this.#database, userId, sessionId);
  }

  pendingSpawnedSessions(): readonly PendingSpawnedSession[] {
    return pendingSpawnedSessions(this.#database, (userId, sessionId) =>
      this.get(userId, sessionId),
    );
  }

  mark(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
    generation?: number,
  ): boolean {
    switch (status) {
      case "failed":
        return (
          this.#finishActiveSession(
            sessionId,
            "failed",
            now,
            SYSTEM_ID,
            undefined,
            generation,
          ) ||
          this.#systemTransition(sessionId, ["queued"], status, now, generation)
        );
      case "idle":
        return this.#finishActiveSession(
          sessionId,
          "idle",
          now,
          SYSTEM_ID,
          undefined,
          generation,
        );
      case "running":
        return this.#startActiveSession(sessionId, now, generation);
    }
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    const stoppedActive = this.#finishActiveSession(
      sessionId,
      "stopped",
      now,
      userId,
      userId,
    );
    return (
      stoppedActive ||
      this.#transition(
        sessionId,
        ["queued", "running", "idle", "failed"],
        "stopped",
        userId,
        now,
        userId,
      )
    );
  }

  queue(
    userId: string,
    sessionId: string,
    now: number,
    prompt?: {
      readonly content: string;
      readonly images: readonly AgentImage[];
    },
  ): QueueSessionResult {
    return queueStoredSession({
      now,
      ...(prompt === undefined ? {} : { prompt }),
      resources: {
        database: this.#database,
        generateId: this.#resources[1],
        read: (ownerId, id) => this.get(ownerId, id),
      },
      sessionId,
      userId,
    });
  }

  failInterrupted(now: number): readonly PendingSpawnedSession[] {
    const interrupted = interruptedStoredSessions(this.#database);

    for (const session of interrupted) {
      const duration = activeSessionDuration(session, now);
      this.#database.transaction((transaction) => {
        insertStoredMessage(transaction, interruptedSessionErrorValues(), {
          actorId: SYSTEM_ID,
          id: this.#generateId(now),
          now,
          sessionId: session.id,
          userId: session.userId,
        });
        updateStoredSession(transaction, session.id, {
          activeDurationMs: duration,
          activeStartedAt: null,
          status: "failed",
          ...updatedAuditFields(SYSTEM_ID, now),
        });
      });
    }
    return this.pendingSpawnedSessions();
  }

  #appendSystemMessage(
    sessionId: string,
    message: StoredMessageValues,
    now: number,
    generation?: number,
  ): void {
    this.#appendMessage(sessionId, message, SYSTEM_ID, now, generation);
  }

  #appendMessage(
    sessionId: string,
    message: StoredMessageValues,
    actorId: string,
    now: number,
    generation?: number,
  ): void {
    this.#database.transaction((transaction) => {
      const session = requireStoredSession(
        transaction
          .select({
            runnerRequired: agentSessions.runnerRequired,
            userId: agentSessions.userId,
          })
          .from(agentSessions)
          .where(sessionGenerationCondition({ id: sessionId }, generation))
          .get(),
      );
      if (actorId === SYSTEM_ID && session.runnerRequired) {
        throw new DOMException("The agent session was stopped", "AbortError");
      }

      insertStoredMessage(transaction, message, {
        actorId,
        id: this.#generateId(now),
        now,
        sessionId,
        userId: session.userId,
      });
      transaction
        .update(agentSessions)
        .set(updatedAuditFields(actorId, now))
        .where(sessionGenerationCondition({ id: sessionId }, generation))
        .run();
    });
  }

  #selectSessions(filter: SessionFilter) {
    return this.#database
      .select(sessionSelection())
      .from(agentSessions)
      .where(activeSessionCondition(filter));
  }

  #startActiveSession(
    sessionId: string,
    now: number,
    generation?: number,
  ): boolean {
    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          activeStartedAt: new Date(now),
          status: "running",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(
          sessionGenerationCondition(
            { id: sessionId, status: "queued" },
            generation,
          ),
        )
        .returning()
        .all(),
    );
  }

  #finishActiveSession(
    sessionId: string,
    status: "failed" | "idle" | "stopped",
    now: number,
    actorId: string = SYSTEM_ID,
    userId?: string,
    generation?: number,
  ): boolean {
    const session = this.#database
      .select(SESSION_TIMING_SELECTION)
      .from(agentSessions)
      .where(runningCondition(sessionId, userId, generation))
      .get();
    if (session?.activeStartedAt === null || session === undefined) {
      return false;
    }

    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          ...sessionTimingUpdate(session, now),
          status,
          ...updatedAuditFields(actorId, now),
        })
        .where(runningCondition(sessionId, userId, generation))
        .returning({ status: agentSessions.status })
        .all(),
    );
  }

  #systemTransition(
    sessionId: string,
    from: readonly AgentSessionStatus[],
    to: AgentSessionStatus,
    now: number,
    generation?: number,
  ): boolean {
    return this.#transition(
      sessionId,
      from,
      to,
      SYSTEM_ID,
      now,
      undefined,
      generation,
    );
  }

  #transition(
    sessionId: string,
    from: readonly AgentSessionStatus[],
    to: AgentSessionStatus,
    actorId: string,
    now: number,
    userId?: string,
    generation?: number,
  ): boolean {
    return transitionStoredSession({
      actorId,
      database: this.#database,
      from,
      ...(generation === undefined ? {} : { generation }),
      now,
      sessionId,
      to,
      ...(userId === undefined ? {} : { userId }),
    });
  }
}
