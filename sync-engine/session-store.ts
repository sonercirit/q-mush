import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
  AgentRecordedMessage,
} from "../shared/agent-loop.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { SessionHistoryPage } from "../shared/session-history.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
  RestartHandoff,
} from "../shared/session-model.ts";
import { createAskQuestionsPersistence } from "./ask-questions-persistence.ts";
import { AskQuestionsStore } from "./ask-questions-store.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import {
  sessionExecutionIsCurrent,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
import { userSessionFilter } from "./session-filter.ts";
import { readStoredSessionHistory } from "./session-history-store.ts";
import {
  cancelPendingInput,
  enqueuePendingInput,
  settleNormalSessionBoundary,
  takeSteeringInputs,
  type EnqueuePendingInputResult,
  type EnqueuePendingSessionInput,
} from "./session-pending-inputs.ts";
import {
  queuedSessionDetails,
  queuedSessionOwnerIds,
} from "./session-queued.ts";
import {
  RestartHandoffStore,
  type RestartHandoffIdentity,
} from "./session-restart-store.ts";
import {
  createStoredSession,
  type CreateAgentSession,
  type CreateSessionResult,
} from "./session-store-create.ts";
import {
  forkStoredSessionFromSource,
  type SessionStoreForkParameters,
  type SessionStoreForkResult,
} from "./session-store-fork.ts";
import {
  activeSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import {
  queueStoredSession,
  type QueueSessionResult,
} from "./session-store-queue.ts";
import {
  appendInterruptedRunnerToolResult,
  appendUnknownRestartToolResults,
  conversationFromMessages,
  readStoredSessionMessages,
  withInterruptedToolResults,
} from "./session-store-read.ts";
import {
  failInterruptedStoredSession,
  interruptedStoredSessions,
  reassignStoredSession,
  type ReassignSessionResult,
} from "./session-store-reassignment.ts";
import {
  appendRuntimeAgentMessages,
  appendRuntimeErrorMessage,
  commitRuntimeTerminal,
  compactRuntimeConversation,
  compactRuntimeTerminal,
  setRuntimeAgentFile,
  updateRuntimeUsage,
} from "./session-store-runtime-writes.ts";
import {
  appendSpawnedSessionReport,
  pendingSpawnedSessions,
  spawnedSessionChildren,
  spawnedSessionLink,
  type PendingSpawnedSession,
  type SpawnedSessionLink,
} from "./session-store-spawns.ts";

import {
  runtimeUsageOption,
  type RuntimeAppendMessageParameters,
  type RuntimeCompactionParameters,
  type RuntimeMessageParameters,
  type RuntimeMessageWriteOptions,
  type RuntimeTerminalMessageParameters,
} from "./session-runtime-write-options.ts";
import {
  listStoredSessions,
  readStoredSessionDetail,
} from "./session-store-queries.ts";
import {
  stopStoredSession,
  transitionSessionRuntime,
} from "./session-store-transitions.ts";
import { appendSessionUserMessage } from "./session-store-values.ts";

export class SessionStore {
  readonly #questions: AskQuestionsStore;
  readonly #resources: readonly [AppDatabase, IdGenerator];
  readonly #restartHandoffs: RestartHandoffStore;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    this.#resources = [database, generateId];
    this.#questions = new AskQuestionsStore({
      generateId,
      persistence: createAskQuestionsPersistence(database),
      systemActorId: SYSTEM_ID,
    });
    this.#restartHandoffs = new RestartHandoffStore({
      database,
      generateId,
      interruptUnknownTools: (transaction, sessionId, now) => {
        this.appendUnknownRestartToolResults(transaction, sessionId, now);
      },
      read: (userId, sessionId) => this.get(userId, sessionId),
    });
  }

  get #database(): AppDatabase {
    return this.#resources[0];
  }

  #writeResources(workspaceId?: string) {
    return {
      database: this.#database,
      generateId: this.#resources[1],
      read: (userId: string, sessionId: string) =>
        this.get(userId, sessionId, workspaceId),
    };
  }

  #generateId(now: number): string {
    return this.#resources[1](now);
  }

  create(input: CreateAgentSession, now: number): CreateSessionResult {
    return createStoredSession(this.#writeResources(), input, now);
  }
  fork(...parameters: SessionStoreForkParameters): SessionStoreForkResult {
    return forkStoredSessionFromSource(
      this.#writeResources(parameters[3]),
      ...parameters,
    );
  }
  questions(): AskQuestionsStore {
    return this.#questions;
  }

  #readPendingQuestions(userId: string, sessionId: string) {
    return this.#questions.pending(userId, sessionId);
  }

  pendingQuestions(
    userId: string,
    sessionId: string,
  ): PendingAskQuestions | null {
    return this.#readPendingQuestions(userId, sessionId);
  }

  executionIsCurrent(
    userId: string,
    sessionId: string,
    generation: number,
    tool?: AgentSessionToolName,
  ): boolean {
    return sessionExecutionIsCurrent(
      this.#database,
      {
        generation,
        sessionId,
        ...(tool === undefined ? {} : { tool }),
      },
      userId,
    );
  }

  get(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): AgentSessionDetail | undefined {
    return readStoredSessionDetail(
      this.#database,
      this.#readPendingQuestions.bind(this),
      userId,
      sessionId,
      workspaceId,
    );
  }
  list(userId: string, workspaceId?: string): readonly AgentSessionSummary[] {
    return listStoredSessions(
      this.#database,
      this.#readPendingQuestions.bind(this),
      userId,
      workspaceId,
    );
  }

  history(
    userId: string,
    sessionId: string,
    cursor: string | null,
  ): SessionHistoryPage | undefined {
    return readStoredSessionHistory(this.#database, userId, {
      cursor,
      sessionId,
    });
  }

  conversation(
    sessionId: string,
    interrupted = true,
  ): readonly AgentConversationMessage[] {
    return conversationFromMessages(
      withInterruptedToolResults(
        readStoredSessionMessages(this.#database, sessionId),
        interrupted,
      ),
    );
  }

  pauseQueuedForRestart(
    ...arguments_: Parameters<RestartHandoffStore["pauseQueued"]>
  ): boolean {
    return this.#restartHandoffs.pauseQueued(...arguments_);
  }

  pauseRunningForRestart(
    ...arguments_: Parameters<RestartHandoffStore["pauseRunning"]>
  ): boolean {
    return this.#restartHandoffs.pauseRunning(...arguments_);
  }

  failInvalidRestartHandoff(
    ...arguments_: Parameters<RestartHandoffStore["failInvalid"]>
  ): boolean {
    return this.#restartHandoffs.failInvalid(...arguments_);
  }

  failRestartHandoff(
    ...arguments_: Parameters<RestartHandoffStore["failQueued"]>
  ): boolean {
    return this.#restartHandoffs.failQueued(...arguments_);
  }

  invalidRestartHandoffs(runnerId?: string) {
    return this.#restartHandoffs.invalid(runnerId);
  }

  pendingRestartHandoffs(runnerId?: string) {
    return this.#restartHandoffs.pending(runnerId);
  }

  claimRestartHandoff(
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ): AgentSessionDetail | undefined {
    return this.#restartHandoffs.claim(userId, identity, now);
  }

  settleRestartHandoff(
    userId: string,
    identity: RestartHandoffIdentity,
    settlement: Parameters<RestartHandoffStore["settle"]>[2],
    now: number,
  ): boolean {
    return this.#restartHandoffs.settle(userId, identity, settlement, now);
  }

  restoreRestartHandoff(
    identity: RestartHandoffIdentity,
    now: number,
  ): boolean {
    return this.#restartHandoffs.restore(identity, now);
  }

  #runtimeTarget(sessionId: string, now: number, generation: number) {
    return {
      generation,
      now,
      resources: this.#writeResources(),
      sessionId,
    };
  }

  setRuntimeAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
    generation: number,
  ): void {
    setRuntimeAgentFile({
      agentFile,
      ...this.#runtimeTarget(sessionId, now, generation),
    });
  }

  #agentMessageWrite(
    parameters: RuntimeMessageParameters,
    options: RuntimeMessageWriteOptions,
  ): void {
    const [sessionId, messages, now, generation] = parameters;
    const target = {
      ...this.#runtimeTarget(sessionId, now, generation),
      messages,
    };
    if (options.kind === "terminal") {
      commitRuntimeTerminal({
        ...target,
        restartHandoff: options.restartHandoff,
        ...runtimeUsageOption(options.usage),
      });
      return;
    }
    appendRuntimeAgentMessages({
      ...target,
      ...runtimeUsageOption(options.usage),
    });
  }

  commitRuntimeTerminal(
    ...[
      sessionId,
      messages,
      now,
      generation,
      restartHandoff,
      usage,
    ]: RuntimeTerminalMessageParameters
  ): void {
    this.#agentMessageWrite([sessionId, messages, now, generation], {
      kind: "terminal",
      restartHandoff,
      ...runtimeUsageOption(usage),
    });
  }

  #compactRuntime(
    parameters:
      | RuntimeCompactionParameters
      | readonly [
          ...RuntimeCompactionParameters,
          restartHandoff: RestartHandoff | null,
        ],
  ): void {
    const [
      sessionId,
      summary,
      usage,
      now,
      generation,
      startedAt,
      restartHandoff,
    ] = parameters;
    const target = this.#runtimeTarget(sessionId, now, generation);
    if (restartHandoff === undefined) {
      compactRuntimeConversation({ ...target, startedAt, summary, usage });
    } else {
      compactRuntimeTerminal({
        ...target,
        restartHandoff,
        startedAt,
        summary,
        usage,
      });
    }
  }

  compactRuntimeTerminal(
    ...parameters: readonly [
      ...RuntimeCompactionParameters,
      restartHandoff: RestartHandoff | null,
    ]
  ): void {
    this.#compactRuntime(parameters);
  }

  compactRuntimeConversation(...parameters: RuntimeCompactionParameters): void {
    this.#compactRuntime(parameters);
  }

  updateRuntimeUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
    generation: number,
  ): void {
    updateRuntimeUsage({
      ...this.#runtimeTarget(sessionId, now, generation),
      input,
    });
  }

  appendRuntimeAgentMessages(
    ...parameters: RuntimeAppendMessageParameters
  ): void {
    const [sessionId, messages, now, generation, usage] = parameters;
    const writeOptions: RuntimeMessageWriteOptions = {
      kind: "append",
      ...runtimeUsageOption(usage),
    };
    this.#agentMessageWrite(
      [sessionId, messages, now, generation],
      writeOptions,
    );
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
    workspaceId?: string,
  ): AgentSessionDetail | undefined {
    const updated = updateStoredSessions(
      this.#database,
      activeSessionCondition(userSessionFilter(userId, sessionId, workspaceId)),
      { autoCompact, ...updatedAuditFields(userId, now) },
    );
    return updated ? this.get(userId, sessionId, workspaceId) : undefined;
  }

  appendUnknownRestartToolResults(
    database: Parameters<typeof appendUnknownRestartToolResults>[0]["database"],
    sessionId: string,
    now: number,
  ): void {
    appendUnknownRestartToolResults({
      database,
      generateId: this.#resources[1],
      now,
      sessionId,
    });
  }

  appendInterruptedRunnerTool(sessionId: string, now: number): void {
    appendInterruptedRunnerToolResult({
      database: this.#database,
      generateId: this.#resources[1],
      now,
      sessionId,
    });
  }

  cancelPendingInput(
    options: Omit<Parameters<typeof cancelPendingInput>[0], "database">,
  ) {
    return cancelPendingInput({ ...options, database: this.#database });
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
    return takeSteeringInputs({ database: this.#database, now, sessionId });
  }

  settleNormalBoundary(sessionId: string, now: number, generation: number) {
    return settleNormalSessionBoundary({
      database: this.#database,
      generation,
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

  spawnedSessionChildren(userId: string, sessionId: string): readonly string[] {
    return spawnedSessionChildren(this.#database, userId, sessionId);
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

  queuedSessionOwnerIds(): readonly string[] {
    return queuedSessionOwnerIds(this.#database);
  }

  queuedSessions(userId: string): readonly AgentSessionDetail[] {
    const awaitingAnsweredLaunch = new Set(
      this.#questions
        .recoverable()
        .filter((request) => request.userId === userId)
        .map((request) => request.sessionId),
    );
    return queuedSessionDetails(this.#database, userId, (ownerId, sessionId) =>
      this.get(ownerId, sessionId),
    ).filter(({ id }) => !awaitingAnsweredLaunch.has(id));
  }

  transitionRuntime(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
    generation: number,
  ): boolean {
    return transitionSessionRuntime({
      generation,
      now,
      resources: { database: this.#database },
      sessionId,
      status,
    });
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
      now,
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
    if (this.#questions.pending(userId, sessionId) !== null) {
      return this.#questions.stop(userId, sessionId, now);
    }
    return stopStoredSession({
      now,
      resources: { database: this.#database },
      sessionId,
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
    authorization?: SessionQueueAuthorization,
    workspaceId?: string,
  ): QueueSessionResult {
    return queueStoredSession({
      ...(authorization === undefined ? {} : { authorization }),
      now,
      ...(prompt === undefined ? {} : { prompt }),
      resources: {
        database: this.#database,
        generateId: this.#resources[1],
        read: (ownerId, id) => this.get(ownerId, id, workspaceId),
      },
      sessionId,
      userId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  }

  failInterrupted(now: number): readonly PendingSpawnedSession[] {
    const interrupted = interruptedStoredSessions(this.#database, now);

    for (const session of interrupted) {
      if (this.#restartHandoffs.restoreInterrupted(session, now)) {
        continue;
      }
      failInterruptedStoredSession(
        this.#database,
        session,
        this.#generateId(now),
        now,
      );
    }
    return this.pendingSpawnedSessions();
  }
}
