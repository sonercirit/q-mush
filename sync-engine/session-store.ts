import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { type AgentFile } from "../shared/agent-file.ts";
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
  AgentSessionCostBasis,
  AgentSessionDetail,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import {
  consumeLeadingFollowUp,
  enqueuePendingInput,
  pendingInputHeadKind,
  settleNormalSessionBoundary,
  storedPendingInputs,
  takeSteeringInputs,
  type EnqueuePendingInputResult,
  type EnqueuePendingSessionInput,
} from "./session-pending-inputs.ts";
import {
  queuedSessionDetails,
  queuedSessionOwnerIds,
} from "./session-queued.ts";
import {
  finishActiveSession,
  readStoredAgentFile,
  startActiveSession,
  systemTransition,
  userTransition,
} from "./session-store-lifecycle.ts";
import {
  conversationFromMessages,
  parseProviderPricing,
  storedSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";
import {
  activeSessionCondition,
  orderedSessions,
  runningCondition,
  selectSessions,
} from "./session-store-selection.ts";
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
  | { readonly status: "not_found" }
  | { readonly status: "pending_input" };

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

function summarizeSession(stored: StoredSessionSummary): AgentSessionSummary {
  return {
    ...stored,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerPricing: parseProviderPricing(stored.providerPricing),
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
    const stored = selectSessions(this.#database, {
      id: sessionId,
      userId,
    }).get();

    if (stored === undefined) {
      return undefined;
    }

    return {
      ...summarizeSession(stored),
      agentFile: readStoredAgentFile(this.#database, sessionId),
      messages: withInterruptedToolResults(
        storedSessionMessages(this.#database, sessionId),
        stored.status !== "queued" && stored.status !== "running",
      ),
      pendingInputs: storedPendingInputs(this.#database, sessionId),
    };
  }

  list(userId: string): readonly AgentSessionSummary[] {
    return orderedSessions(this.#database, userId).all().map(summarizeSession);
  }

  conversation(sessionId: string): readonly AgentConversationMessage[] {
    return conversationFromMessages(
      withInterruptedToolResults(
        storedSessionMessages(this.#database, sessionId),
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
    },
    now: number,
  ): void {
    this.#database
      .update(agentSessions)
      .set({ ...values, ...updatedAuditFields(SYSTEM_ID, now) })
      .where(runningCondition(sessionId))
      .run();
  }

  setAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void {
    this.#updateRunningSession(
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

  enqueuePendingInput(
    userId: string,
    sessionId: string,
    input: EnqueuePendingSessionInput,
    now: number,
  ): EnqueuePendingInputResult {
    return enqueuePendingInput({
      database: this.#database,
      generateId: this.#resources[1],
      input,
      now,
      sessionId,
      userId,
    });
  }

  takeSteeringInputs(
    sessionId: string,
    now: number,
  ): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
    return takeSteeringInputs({
      database: this.#database,
      now,
      sessionId,
    });
  }

  settleNormalBoundary(sessionId: string, now: number) {
    return settleNormalSessionBoundary({
      database: this.#database,
      now,
      sessionId,
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

  queuedSessionOwnerIds(): readonly string[] {
    return queuedSessionOwnerIds(this.#database);
  }

  queuedSessions(userId: string): readonly AgentSessionDetail[] {
    return queuedSessionDetails(this.#database, userId, (ownerId, sessionId) =>
      this.get(ownerId, sessionId),
    );
  }

  mark(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean {
    switch (status) {
      case "failed":
        return (
          finishActiveSession({
            actorId: SYSTEM_ID,
            database: this.#database,
            now,
            sessionId,
            status: "failed",
          }) ||
          systemTransition({
            database: this.#database,
            from: ["queued"],
            now,
            sessionId,
            to: status,
          })
        );
      case "idle":
        return finishActiveSession({
          actorId: SYSTEM_ID,
          database: this.#database,
          now,
          sessionId,
          status: "idle",
        });
      case "running":
        return startActiveSession(this.#database, sessionId, now);
    }
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    if (
      finishActiveSession({
        actorId: userId,
        database: this.#database,
        now,
        sessionId,
        status: "stopped",
        userId,
      })
    ) {
      return true;
    }

    return userTransition({
      database: this.#database,
      from: ["queued", "running", "idle", "failed"],
      now,
      sessionId,
      to: "stopped",
      userId,
    });
  }

  queue(
    userId: string,
    sessionId: string,
    now: number,
    prompt?: {
      readonly content: string;
      readonly images: readonly AgentImage[];
    },
    consumePendingFollowUp = true,
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
        stored.status !== "stopped"
      ) {
        return "busy" as const;
      }

      const pendingKind = pendingInputHeadKind(transaction, sessionId);
      if (
        pendingKind !== undefined &&
        (prompt !== undefined || !consumePendingFollowUp)
      ) {
        return "pending_input" as const;
      }
      if (pendingKind === "follow_up") {
        consumeLeadingFollowUp(transaction, sessionId, userId, now);
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

  recoverInterrupted(now: number): readonly PendingSpawnedSession[] {
    const interrupted = this.#database
      .select({
        ...SESSION_TIMING_SELECTION,
        id: agentSessions.id,
        status: agentSessions.status,
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
      if (session.status === "queued") {
        continue;
      }
      const duration = activeSessionDuration(session, now);
      this.#database.transaction((transaction) => {
        insertStoredMessage(transaction, interruptedSessionErrorValues(), {
          actorId: SYSTEM_ID,
          id: this.#generateId(now),
          now,
          sessionId: session.id,
          userId: session.userId,
        });
        const recoverQueued = consumeLeadingFollowUp(
          transaction,
          session.id,
          session.userId,
          now + 1,
        );
        transaction
          .update(agentSessions)
          .set({
            activeDurationMs: duration,
            activeStartedAt: null,
            status: recoverQueued ? "queued" : "failed",
            ...updatedAuditFields(SYSTEM_ID, now),
          })
          .where(eq(agentSessions.id, session.id))
          .run();
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
}
