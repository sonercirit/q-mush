import { desc } from "drizzle-orm";
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
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import {
  sessionExecutionIsCurrent,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
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
  appendRuntimeAgentMessages,
  appendRuntimeErrorMessage,
  compactRuntimeConversation,
  setRuntimeAgentFile,
  updateRuntimeUsage,
} from "./session-store-runtime-writes.ts";
import {
  appendSpawnedSessionReport,
  pendingSpawnedSessions,
  spawnedSessionLink,
  type PendingSpawnedSession,
  type SpawnedSessionLink,
} from "./session-store-spawns.ts";

import {
  appendSessionUserMessage,
  insertStoredMessage,
  interruptedSessionErrorValues,
} from "./session-store-values.ts";

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

  #writeResources() {
    return {
      database: this.#database,
      generateId: this.#resources[1],
    };
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
  executionIsCurrent(
    userId: string,
    sessionId: string,
    generation: number,
  ): boolean {
    return sessionExecutionIsCurrent(
      this.#database,
      { generation, sessionId },
      userId,
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
  setRuntimeAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
    generation: number,
  ): void {
    setRuntimeAgentFile({
      agentFile,
      generation,
      now,
      resources: this.#writeResources(),
      sessionId,
    });
  }

  compactRuntimeConversation(
    sessionId: string,
    summary: string,
    usage: CompactionUsage,
    now: number,
    generation: number,
  ): void {
    compactRuntimeConversation({
      generation,
      now,
      resources: this.#writeResources(),
      sessionId,
      summary,
      usage,
    });
  }

  updateRuntimeUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
    generation: number,
  ): void {
    updateRuntimeUsage({
      generation,
      input,
      now,
      resources: this.#writeResources(),
      sessionId,
    });
  }

  appendRuntimeAgentMessages(
    sessionId: string,
    messages: readonly AgentRecordedMessage[],
    now: number,
    generation: number,
    usage?: AgentSessionUsageUpdate,
  ): void {
    appendRuntimeAgentMessages({
      generation,
      messages,
      now,
      resources: this.#writeResources(),
      sessionId,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  appendRuntimeErrorMessage(
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ): void {
    appendRuntimeErrorMessage({
      content,
      generation,
      now,
      resources: this.#writeResources(),
      sessionId,
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
    childGeneration: number,
    parentId: string,
    parentGeneration: number,
    content: string,
    now: number,
  ): boolean {
    return appendSpawnedSessionReport({
      childGeneration,
      childId,
      content,
      database: this.#database,
      generateId: this.#resources[1],
      now,
      parentGeneration,
      parentId,
      userId,
    });
  }

  spawnedSessionLink(
    userId: string,
    sessionId: string,
  ): SpawnedSessionLink | undefined {
    return spawnedSessionLink(this.#database, userId, sessionId);
  }

  pendingSpawnedSessions(): readonly PendingSpawnedSession[] {
    return pendingSpawnedSessions(this.#database, (userId, sessionId) =>
      this.get(userId, sessionId),
    );
  }

  transitionRuntime(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
    generation: number,
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

  /**
   * Administrative/test helper that intentionally targets the current generation.
   * Runtime code must use the generation-required methods above.
   */
  #currentGeneration(sessionId: string): number {
    const current = this.#database
      .select({ generation: agentSessions.executionGeneration })
      .from(agentSessions)
      .where(activeSessionCondition({ id: sessionId }))
      .get();
    if (current === undefined) {
      throw new DOMException("The agent session was stopped", "AbortError");
    }
    return current.generation;
  }

  appendCurrentAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ): void {
    this.appendRuntimeAgentMessages(
      sessionId,
      [message],
      now,
      this.#currentGeneration(sessionId),
    );
  }

  appendCurrentErrorMessage(
    sessionId: string,
    content: string,
    now: number,
  ): void {
    this.appendRuntimeErrorMessage(
      sessionId,
      content,
      now,
      this.#currentGeneration(sessionId),
    );
  }

  compactCurrentConversation(
    sessionId: string,
    summary: string,
    usage: CompactionUsage,
    now: number,
  ): void {
    this.compactRuntimeConversation(
      sessionId,
      summary,
      usage,
      now,
      this.#currentGeneration(sessionId),
    );
  }

  setCurrentAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void {
    this.setRuntimeAgentFile(
      sessionId,
      agentFile,
      now,
      this.#currentGeneration(sessionId),
    );
  }

  updateCurrentUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
  ): void {
    this.updateRuntimeUsage(
      sessionId,
      input,
      now,
      this.#currentGeneration(sessionId),
    );
  }

  transitionCurrent(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean {
    try {
      return this.transitionRuntime(
        sessionId,
        status,
        now,
        this.#currentGeneration(sessionId),
      );
    } catch {
      return false;
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
    authorization?: SessionQueueAuthorization,
  ): QueueSessionResult {
    return queueStoredSession({
      ...(authorization === undefined ? {} : { authorization }),
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
