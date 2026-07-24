import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { readAgentFile, type AgentFile } from "../shared/agent-file.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
  AgentRecordedMessage,
} from "../shared/agent-loop.ts";
import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
  RestartHandoffRequester,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import {
  activeSessionCondition,
  SessionLifecycleStore,
  type SessionFilter,
} from "./session-lifecycle-store.ts";
import {
  RestartHandoffStore,
  type PendingRestartSession,
} from "./session-restart-store.ts";
import {
  conversationFromMessages,
  parseProviderPricing,
  storedSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";
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
  userMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";

export interface CreateAgentSession extends Pick<
  AgentSessionSummary,
  | "autoCompact"
  | "maxContextTokens"
  | "model"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "runnerId"
  | "tools"
  | "workingDirectory"
> {
  readonly credentialId: string;
  readonly images: readonly AgentImage[];
  readonly parentSessionId?: string;
  readonly prompt: string;
  readonly userId: string;
}

export type QueueSessionResult =
  | { readonly detail: AgentSessionDetail; readonly status: "queued" }
  | { readonly status: "busy" }
  | { readonly status: "not_found" };

function requireStoredSession<Value>(stored: Value | undefined): Value {
  if (stored === undefined) {
    throw new Error("The agent session no longer exists");
  }

  return stored;
}

const SESSION_TIMING_SELECTION = {
  activeDurationMs: agentSessions.activeDurationMs,
  activeStartedAt: agentSessions.activeStartedAt,
};

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
    id: agentSessions.id,
    maxContextTokens: agentSessions.maxContextTokens,
    model: agentSessions.model,
    provider: agentSessions.provider,
    providerPricing: agentSessions.providerPricing,
    reasoningEffort: agentSessions.reasoningEffort,
    restartHandoff: agentSessions.restartHandoff,
    runnerId: agentSessions.runnerId,
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
  | "id"
  | "maxContextTokens"
  | "model"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "restartHandoff"
  | "runnerId"
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

function summarizeSession(
  stored: StoredSessionSummary,
  restartHandoff: AgentSessionSummary["restartHandoff"],
): AgentSessionSummary {
  return {
    ...stored,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerPricing: parseProviderPricing(stored.providerPricing),
    restartHandoff,
    tools: parseStoredTools(stored.tools),
    updatedAt: stored.updatedAt.getTime(),
  };
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "Image task").slice(0, 80);
}

function interruptedStatusValues(
  status: "failed" | "paused",
  activeDurationMs: number,
  now: number,
) {
  return {
    activeDurationMs,
    activeStartedAt: null,
    status,
    ...updatedAuditFields(SYSTEM_ID, now),
  };
}

type SessionDatabaseExecutor = Pick<AppDatabase, "update">;

function setInterruptedStatus(
  database: SessionDatabaseExecutor,
  sessionId: string,
  status: "failed" | "paused",
  activeDurationMs: number,
  now: number,
): void {
  const condition = eq(agentSessions.id, sessionId);
  database
    .update(agentSessions)
    .set(interruptedStatusValues(status, activeDurationMs, now))
    .where(condition)
    .run();
}

export class SessionStore {
  readonly #lifecycle: SessionLifecycleStore;
  readonly #restartHandoffs: RestartHandoffStore;
  readonly #resources: readonly [AppDatabase, IdGenerator];

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#resources = [database, generateId];
    this.#lifecycle = new SessionLifecycleStore({ database });
    this.#restartHandoffs = new RestartHandoffStore({
      database,
      read: (userId, sessionId) => this.get(userId, sessionId),
    });
  }

  get #database(): AppDatabase {
    return this.#resources[0];
  }

  #generateId(now: number): string {
    return this.#resources[1](now);
  }

  create(input: CreateAgentSession, now: number): AgentSessionDetail {
    if (
      input.maxContextTokens !== null &&
      (!Number.isSafeInteger(input.maxContextTokens) ||
        input.maxContextTokens <= 0)
    ) {
      throw new Error("The agent session context limit is invalid");
    }

    const sessionId = this.#generateId(now);
    const messageId = this.#generateId(now);

    this.#database.transaction((transaction) => {
      transaction
        .insert(agentSessions)
        .values({
          ...createdAuditFields(input.userId, now),
          autoCompact: input.autoCompact,
          id: sessionId,
          maxContextTokens: input.maxContextTokens,
          model: input.model,
          parentSessionId: input.parentSessionId ?? null,
          provider: input.provider,
          providerCredentialId: input.credentialId,
          providerPricing:
            input.providerPricing === null
              ? null
              : JSON.stringify(input.providerPricing),
          reasoningEffort: input.reasoningEffort,
          runnerId: input.runnerId,
          status: "queued",
          title: titleFromPrompt(input.prompt),
          tools: JSON.stringify(input.tools),
          userId: input.userId,
          workingDirectory: input.workingDirectory,
        })
        .run();
      transaction
        .insert(agentMessages)
        .values(
          userMessageValues({
            content: input.prompt,
            id: messageId,
            images: input.images,
            now,
            sessionId,
            userId: input.userId,
          }),
        )
        .run();
    });

    const created = this.get(input.userId, sessionId);

    if (created === undefined) {
      throw new Error("The agent session could not be read after creation");
    }

    return created;
  }

  get(userId: string, sessionId: string): AgentSessionDetail | undefined {
    const stored = this.#selectSessions({ id: sessionId, userId }).get();

    if (stored === undefined) {
      return undefined;
    }

    return {
      ...summarizeSession(
        stored,
        this.#restartHandoffs.parse(stored.restartHandoff),
      ),
      agentFile: this.#agentFile(sessionId),
      messages: withInterruptedToolResults(
        storedSessionMessages(this.#database, sessionId),
        stored.status !== "queued" &&
          stored.status !== "running" &&
          stored.status !== "paused",
      ),
    };
  }

  list(userId: string): readonly AgentSessionSummary[] {
    return this.#selectSessions({ userId })
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
      .all()
      .map((stored) =>
        summarizeSession(
          stored,
          this.#restartHandoffs.parse(stored.restartHandoff),
        ),
      );
  }

  conversation(sessionId: string): readonly AgentConversationMessage[] {
    return conversationFromMessages(
      withInterruptedToolResults(
        storedSessionMessages(this.#database, sessionId),
        true,
      ),
    );
  }

  setAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void {
    this.#lifecycle.updateRunning(
      sessionId,
      {
        agentFileContent: agentFile?.content ?? null,
        agentFileName: agentFile?.name ?? null,
      },
      now,
    );
  }

  compact(sessionId: string, summary: string, now: number): void {
    compactStoredConversation({
      database: this.#database,
      generateId: (timestamp) => this.#generateId(timestamp),
      now,
      sessionId,
      summary,
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

    this.#lifecycle.updateRunning(
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
    );
  }

  appendAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ): void {
    this.#appendMessage(
      sessionId,
      recordedMessageValues(message),
      SYSTEM_ID,
      now,
    );
  }

  appendErrorMessage(sessionId: string, content: string, now: number): void {
    this.#appendMessage(sessionId, errorMessageValues(content), SYSTEM_ID, now);
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
  ): boolean {
    return this.#lifecycle.mark(sessionId, status, now);
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    return this.#lifecycle.stop(userId, sessionId, now);
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
    const messageId = prompt === undefined ? undefined : this.#generateId(now);
    const status = this.#database.transaction((transaction) => {
      const stored = transaction
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(activeSessionCondition({ id: sessionId, userId }))
        .get();

      if (stored === undefined) {
        return "not_found" as const;
      }

      if (
        stored.status !== "idle" &&
        stored.status !== "failed" &&
        stored.status !== "stopped" &&
        stored.status !== "paused"
      ) {
        return "busy" as const;
      }

      if (prompt !== undefined && messageId !== undefined) {
        transaction
          .insert(agentMessages)
          .values(
            userMessageValues({
              content: prompt.content,
              id: messageId,
              images: prompt.images,
              now,
              sessionId,
              userId,
            }),
          )
          .run();
      }
      transaction
        .update(agentSessions)
        .set({
          activeStartedAt: null,
          status: "queued",
          ...updatedAuditFields(userId, now),
        })
        .where(eq(agentSessions.id, sessionId))
        .run();
      return "queued" as const;
    });

    if (status !== "queued") {
      return { status };
    }

    const detail = this.get(userId, sessionId);

    if (detail === undefined) {
      throw new Error("The queued agent session could not be read");
    }

    return { detail, status };
  }

  pauseQueuedForRestart(
    // cpd-ignore-start -- Queued and running handoffs intentionally share one facade signature.
    sessionId: string,
    requestedBy: RestartHandoffRequester,
    restartId: string,
    now: number,
  ): boolean {
    return this.#restartHandoffs.pauseQueued(
      sessionId,
      requestedBy,
      restartId,
      now,
    );
  }

  pauseForRestart(
    sessionId: string,
    requestedBy: RestartHandoffRequester,
    restartId: string,
    now: number,
  ): boolean {
    return this.#restartHandoffs.pauseRunning(
      sessionId,
      requestedBy,
      restartId,
      now,
    );
  }
  // cpd-ignore-end

  pendingRestartHandoffs(runnerId?: string): readonly PendingRestartSession[] {
    return this.#restartHandoffs.pending(runnerId);
  }

  claimRestartHandoff(
    userId: string,
    sessionId: string,
    restartId: string,
    now: number,
  ): AgentSessionDetail | undefined {
    return this.#restartHandoffs.claim(userId, sessionId, restartId, now);
  }

  completeRestartHandoff(sessionId: string): void {
    this.#restartHandoffs.complete(sessionId);
  }

  finishRestartHandoff(sessionId: string): void {
    this.#restartHandoffs.finish(sessionId);
  }

  restoreRestartHandoff(sessionId: string, now: number): void {
    this.#restartHandoffs.restore(sessionId, now);
  }

  failInterrupted(now: number): readonly PendingSpawnedSession[] {
    const interrupted = this.#database
      .select({
        ...SESSION_TIMING_SELECTION,
        id: agentSessions.id,
        restartHandoff: agentSessions.restartHandoff,
        userId: agentSessions.userId,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.isDeleted, false),
          inArray(agentSessions.status, ["queued", "running"]),
        ),
      )
      .all();

    for (const session of interrupted) {
      const duration = activeSessionDuration(session, now);
      if (session.restartHandoff !== null) {
        setInterruptedStatus(
          this.#database,
          session.id,
          "paused",
          duration,
          now,
        );
        continue;
      }
      this.#database.transaction((transaction) => {
        insertStoredMessage(transaction, interruptedSessionErrorValues(), {
          actorId: SYSTEM_ID,
          id: this.#generateId(now),
          now,
          sessionId: session.id,
          userId: session.userId,
        });
        setInterruptedStatus(transaction, session.id, "failed", duration, now);
      });
    }
    return this.pendingSpawnedSessions();
  }

  #appendMessage(
    sessionId: string,
    message: StoredMessageValues,
    actorId: string,
    now: number,
  ): void {
    this.#database.transaction((transaction) => {
      const session = requireStoredSession(
        transaction
          .select({ userId: agentSessions.userId })
          .from(agentSessions)
          .where(activeSessionCondition({ id: sessionId }))
          .get(),
      );

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
        .where(eq(agentSessions.id, sessionId))
        .run();
    });
  }

  #selectSessions(filter: SessionFilter) {
    return this.#database
      .select(sessionSelection())
      .from(agentSessions)
      .where(activeSessionCondition(filter));
  }

  #agentFile(sessionId: string): AgentFile | null {
    const condition = activeSessionCondition({ id: sessionId });
    const stored = requireStoredSession(
      this.#database
        .select({
          content: agentSessions.agentFileContent,
          name: agentSessions.agentFileName,
        })
        .from(agentSessions)
        .where(condition)
        .get(),
    );

    return readAgentFile(
      stored.content === null && stored.name === null ? null : stored,
    );
  }
}
