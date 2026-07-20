import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import {
  readAgentToolCalls,
  type AgentConversationMessage,
  type AgentRecordedMessage,
  type AgentToolCall,
} from "./agent-loop.ts";
import { createdAuditFields, updatedAuditFields } from "./audit.ts";
import type { AppDatabase } from "./database.ts";
import { agentMessages, agentSessions } from "./database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "./ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./session-model.ts";

export interface CreateAgentSession extends Pick<
  AgentSessionSummary,
  "model" | "provider" | "reasoningEffort" | "runnerId" | "workingDirectory"
> {
  readonly credentialId: string;
  readonly prompt: string;
  readonly userId: string;
}

export type QueuePromptResult =
  | { readonly detail: AgentSessionDetail; readonly status: "queued" }
  | { readonly status: "busy" }
  | { readonly status: "not_found" };

interface SessionFilter {
  readonly id?: string;
  readonly userId?: string;
}

function activeSessionCondition(filter: SessionFilter): SQL | undefined {
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
  );
}

function sessionSelection() {
  return {
    createdAt: agentSessions.createdAt,
    credentialId: agentSessions.providerCredentialId,
    id: agentSessions.id,
    model: agentSessions.model,
    provider: agentSessions.provider,
    reasoningEffort: agentSessions.reasoningEffort,
    runnerId: agentSessions.runnerId,
    status: agentSessions.status,
    title: agentSessions.title,
    updatedAt: agentSessions.updatedAt,
    workingDirectory: agentSessions.workingDirectory,
  };
}

function messageSelection() {
  return {
    content: agentMessages.content,
    createdAt: agentMessages.createdAt,
    id: agentMessages.id,
    role: agentMessages.role,
    toolCallId: agentMessages.toolCallId,
    toolCalls: agentMessages.toolCalls,
    toolName: agentMessages.toolName,
  };
}

type StoredSessionSummary = Pick<
  typeof agentSessions.$inferSelect,
  | "createdAt"
  | "id"
  | "model"
  | "provider"
  | "reasoningEffort"
  | "runnerId"
  | "status"
  | "title"
  | "updatedAt"
  | "workingDirectory"
> & { readonly credentialId: string };

function summarizeSession(stored: StoredSessionSummary): AgentSessionSummary {
  return {
    ...stored,
    createdAt: stored.createdAt.getTime(),
    updatedAt: stored.updatedAt.getTime(),
  };
}

function parseToolCalls(value: string | null): readonly AgentToolCall[] {
  if (value === null) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return readAgentToolCalls(parsed, "A stored agent tool call is invalid");
    }
  } catch {
    // The common error below identifies corrupt local data.
  }

  throw new Error("Stored agent tool calls are invalid");
}

type StoredMessage = Omit<AgentSessionMessage, "createdAt" | "toolCalls"> & {
  readonly createdAt: Date;
  readonly toolCalls: string | null;
};

function summarizeMessage(stored: StoredMessage): AgentSessionMessage {
  return {
    ...stored,
    createdAt: stored.createdAt.getTime(),
    toolCalls: parseToolCalls(stored.toolCalls),
  };
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "New agent session").slice(0, 80);
}

type StoredMessageValues = Pick<
  StoredMessage,
  "content" | "role" | "toolCallId" | "toolCalls" | "toolName"
>;

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
    role: "tool",
    toolCallId: message.toolCallId,
    toolCalls: null,
    toolName: message.toolName,
  };
}

function emptyToolMetadata() {
  return { toolCallId: null, toolCalls: null, toolName: null };
}

function userMessageValues(options: {
  readonly content: string;
  readonly id: string;
  readonly now: number;
  readonly sessionId: string;
  readonly userId: string;
}) {
  return {
    ...createdAuditFields(options.userId, options.now),
    content: options.content,
    id: options.id,
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
    const sessionId = this.#generateId(now);
    const messageId = this.#generateId(now);

    this.#database.transaction((transaction) => {
      transaction
        .insert(agentSessions)
        .values({
          ...createdAuditFields(input.userId, now),
          id: sessionId,
          model: input.model,
          provider: input.provider,
          providerCredentialId: input.credentialId,
          reasoningEffort: input.reasoningEffort,
          runnerId: input.runnerId,
          status: "queued",
          title: titleFromPrompt(input.prompt),
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
      messages: this.#messages(sessionId),
    };
  }

  list(userId: string): readonly AgentSessionSummary[] {
    return this.#selectSessions({ userId })
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
      .all()
      .map(summarizeSession);
  }

  conversation(sessionId: string): readonly AgentConversationMessage[] {
    const conversation: AgentConversationMessage[] = [];

    for (const message of this.#messages(sessionId)) {
      switch (message.role) {
        case "assistant":
          conversation.push({
            content: message.content,
            role: "assistant",
            toolCalls: message.toolCalls,
          });
          break;
        case "tool":
          if (message.toolCallId === null || message.toolName === null) {
            throw new Error("A stored tool result has no tool identity");
          }

          conversation.push({
            content: message.content,
            role: "tool",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
          });
          break;
        case "user":
          conversation.push({ content: message.content, role: "user" });
          break;
        case "system":
        case "thinking":
          break;
      }
    }

    return conversation;
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
        return this.#systemTransition(
          sessionId,
          ["queued", "running"],
          status,
          now,
        );
      case "idle":
        return this.#systemTransition(sessionId, ["running"], status, now);
      case "running":
        return this.#systemTransition(sessionId, ["queued"], status, now);
    }
  }

  stop(userId: string, sessionId: string, now: number): boolean {
    return this.#transition(
      sessionId,
      ["queued", "running", "idle", "failed"],
      "stopped",
      userId,
      now,
      userId,
    );
  }

  queuePrompt(
    userId: string,
    sessionId: string,
    prompt: string,
    now: number,
  ): QueuePromptResult {
    const messageId = this.#generateId(now);
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

      transaction
        .insert(agentMessages)
        .values(
          userMessageValues({
            content: prompt,
            id: messageId,
            now,
            sessionId,
            userId,
          }),
        )
        .run();
      transaction
        .update(agentSessions)
        .set({ status: "queued", ...updatedAuditFields(userId, now) })
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
    this.#database
      .update(agentSessions)
      .set({ status: "failed", ...updatedAuditFields(SYSTEM_ID, now) })
      .where(
        and(
          eq(agentSessions.isDeleted, false),
          inArray(agentSessions.status, ["queued", "running"]),
        ),
      )
      .run();
  }

  #appendMessage(
    sessionId: string,
    message: StoredMessageValues,
    actorId: string,
    now: number,
  ): void {
    this.#database.transaction((transaction) => {
      const session = transaction
        .select({ userId: agentSessions.userId })
        .from(agentSessions)
        .where(activeSessionCondition({ id: sessionId }))
        .get();

      if (session === undefined) {
        throw new Error("The agent session no longer exists");
      }

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

  #messages(sessionId: string): readonly AgentSessionMessage[] {
    return this.#database
      .select(messageSelection())
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.isDeleted, false),
          eq(agentMessages.sessionId, sessionId),
        ),
      )
      .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
      .all()
      .map(summarizeMessage);
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
    const updated = this.#database
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
      .returning({ id: agentSessions.id })
      .all();
    return updated.length > 0;
  }
}
