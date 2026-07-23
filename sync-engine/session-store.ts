import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
  AgentSessionCostBasis,
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { compactStoredConversation } from "./session-compaction.ts";
import {
  conversationFromMessages,
  parseProviderPricing,
  storedSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";

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
  readonly prompt: string;
  readonly userId: string;
}

export type QueueSessionResult =
  | { readonly detail: AgentSessionDetail; readonly status: "queued" }
  | { readonly status: "busy" }
  | { readonly status: "not_found" };

interface SessionFilter {
  readonly id?: string;
  readonly status?: AgentSessionStatus;
  readonly userId?: string;
}

function activeSessionCondition(filter: SessionFilter): SQL | undefined {
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.status === undefined
      ? undefined
      : eq(agentSessions.status, filter.status),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
  );
}

function runningCondition(sessionId: string, userId?: string): SQL | undefined {
  return activeSessionCondition({
    id: sessionId,
    status: "running",
    ...(userId === undefined ? {} : { userId }),
  });
}

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

function didUpdate(rows: readonly unknown[]): boolean {
  return rows.length > 0;
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
    id: agentSessions.id,
    maxContextTokens: agentSessions.maxContextTokens,
    model: agentSessions.model,
    provider: agentSessions.provider,
    providerPricing: agentSessions.providerPricing,
    reasoningEffort: agentSessions.reasoningEffort,
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

interface StoredMessageValues {
  readonly content: string;
  readonly images: string | null;
  readonly role: "assistant" | "system" | "thinking" | "tool";
  readonly toolCallId: string | null;
  readonly toolCalls: string | null;
  readonly toolName: string | null;
}

function recordedMessageValues(
  message: AgentRecordedMessage,
): StoredMessageValues {
  if (message.role === "assistant") {
    return {
      ...emptyToolMetadata(),
      content: message.content,
      role: "assistant",
      toolCalls: JSON.stringify(message.toolCalls),
    };
  }

  if (message.role === "thinking") {
    return {
      ...emptyToolMetadata(),
      content: message.content,
      role: "thinking",
    };
  }

  return {
    content: message.content,
    images: null,
    role: "tool",
    toolCallId: message.toolCallId,
    toolCalls: null,
    toolName: message.toolName,
  };
}

function emptyToolMetadata() {
  return {
    images: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
  };
}

function userMessageValues(options: {
  readonly content: string;
  readonly id: string;
  readonly images: readonly AgentImage[];
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}) {
  return {
    ...createdAuditFields(options.userId, options.now),
    content: options.content,
    id: options.id,
    images: options.images.length === 0 ? null : JSON.stringify(options.images),
    role: "user" as const,
    sessionId: options.sessionId,
    userId: options.userId,
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
      ...summarizeSession(stored),
      agentFile: this.#agentFile(sessionId),
      messages: withInterruptedToolResults(
        storedSessionMessages(this.#database, sessionId),
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

  appendSystemMessage(sessionId: string, content: string, now: number): void {
    this.#appendMessage(
      sessionId,
      { ...emptyToolMetadata(), content, role: "system" },
      SYSTEM_ID,
      now,
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
          this.#finishActiveSession(sessionId, "failed", now) ||
          this.#systemTransition(sessionId, ["queued"], status, now)
        );
      case "idle":
        return this.#finishActiveSession(sessionId, "idle", now);
      case "running":
        return this.#startActiveSession(sessionId, now);
    }
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    if (this.#finishActiveSession(sessionId, "stopped", now, userId, userId)) {
      return true;
    }

    return this.#transition(
      sessionId,
      ["queued", "running", "idle", "failed"],
      "stopped",
      userId,
      now,
      userId,
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

  failInterrupted(now: number): void {
    const interrupted = this.#database
      .select({ ...SESSION_TIMING_SELECTION, id: agentSessions.id })
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
      this.#database
        .update(agentSessions)
        .set({
          activeDurationMs: duration,
          activeStartedAt: null,
          status: "failed",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(eq(agentSessions.id, session.id))
        .run();
    }
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

      transaction
        .insert(agentMessages)
        .values({
          ...createdAuditFields(actorId, now),
          ...message,
          id: this.#generateId(now),
          sessionId,
          userId: session.userId,
        })
        .run();
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

  #startActiveSession(sessionId: string, now: number): boolean {
    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          activeStartedAt: new Date(now),
          status: "running",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(activeSessionCondition({ id: sessionId, status: "queued" }))
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
  ): boolean {
    const session = this.#database
      .select(SESSION_TIMING_SELECTION)
      .from(agentSessions)
      .where(runningCondition(sessionId, userId))
      .get();
    if (session?.activeStartedAt === null || session === undefined) {
      return false;
    }

    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          activeDurationMs: activeSessionDuration(session, now),
          activeStartedAt: null,
          status,
          ...updatedAuditFields(actorId, now),
        })
        .where(runningCondition(sessionId, userId))
        .returning({ status: agentSessions.status })
        .all(),
    );
  }

  #systemTransition(
    sessionId: string,
    from: readonly AgentSessionStatus[],
    to: AgentSessionStatus,
    now: number,
  ): boolean {
    return this.#transition(sessionId, from, to, SYSTEM_ID, now);
  }

  #transition(
    sessionId: string,
    from: readonly AgentSessionStatus[],
    to: AgentSessionStatus,
    actorId: string,
    now: number,
    userId?: string,
  ): boolean {
    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({ status: to, ...updatedAuditFields(actorId, now) })
        .where(
          and(
            activeSessionCondition({
              id: sessionId,
              ...(userId === undefined ? {} : { userId }),
            }),
            inArray(agentSessions.status, from),
          ),
        )
        .returning({ updatedAt: agentSessions.updatedAt })
        .all(),
    );
  }
}
