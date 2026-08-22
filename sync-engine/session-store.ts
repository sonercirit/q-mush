import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
  AgentStepTruncation,
} from "../shared/agent-loop.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type { AppDatabase } from "../shared/database.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { SessionHistoryPage } from "../shared/session-history.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { AnthropicReplayIdentity } from "./anthropic-replay-identity.ts";
import { createAskQuestionsPersistence } from "./ask-questions-persistence.ts";
import { AskQuestionsStore } from "./ask-questions-store.ts";
import { CurrentSessionStore } from "./session-current-store.ts";
import {
  sessionExecutionIsCurrent,
  type SessionExecutionAuthority,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
import { readStoredSessionHistory } from "./session-history-store.ts";
import {
  repairSpawnedSessionLineage,
  type SpawnLineageRepairResult,
} from "./session-lineage-repair.ts";
import { ManualCompactionStore } from "./session-manual-compaction-store.ts";
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
import type { SessionRuntimes } from "./session-runtime.ts";
import {
  claimSpawnedSessionReservation,
  discardSpawnedSessionReservation,
  failSpawnedSessionReservation,
  prepareSpawnedSessionReservation,
  recoverSpawnedSessionReservations,
  type SpawnedSessionMetadata,
} from "./session-spawn-reservation-store.ts";
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
import { activeSessionCondition } from "./session-store-persistence.ts";
import {
  listStoredSessions,
  readStoredSessionDetail,
} from "./session-store-queries.ts";
import {
  queueStoredSession,
  type QueueSessionResult,
} from "./session-store-queue.ts";
import {
  appendInterruptedRunnerToolResult,
  appendUnknownRestartToolResults,
  conversationFromInternalMessages,
  readInternalSessionMessages,
  readStoredSessionMessages,
  storedConversationTruncation,
  withInterruptedInternalToolResults,
} from "./session-store-read.ts";
import {
  failInterruptedStoredSession,
  interruptedStoredSessions,
  reassignStoredSession,
  type ReassignSessionResult,
} from "./session-store-reassignment.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import { SessionStoreRestarts } from "./session-store-restarts.ts";
import {
  setSessionCompactionFlag,
  setSessionContextTokenCap,
  type SessionCompactionFlagParameters,
  type SessionContextTokenCapParameters,
} from "./session-store-settings.ts";
import {
  activeSpawnedSessionChildren,
  appendSpawnedSessionReport,
  pendingSpawnedSessions,
  spawnedSessionChildren,
  spawnedSessionLink,
  type PendingSpawnedSession,
  type SpawnedReportDisposition,
} from "./session-store-spawns.ts";
import { readStoredSessionGeneration } from "./session-store-state.ts";
import {
  stopStoredSession,
  transitionSessionRuntime,
} from "./session-store-transitions.ts";
import { appendSessionUserMessage } from "./session-store-values.ts";
import { activeSessionToolSettings } from "./session-turn-store.ts";
export class SessionStore extends SessionStoreRestarts {
  readonly #manualCompactions: ManualCompactionStore;
  readonly #questions: AskQuestionsStore;
  readonly #reportParent: SessionStoreWriteResources["reportParent"];
  readonly #resources: readonly [AppDatabase, IdGenerator];
  readonly #runtimes: Pick<SessionRuntimes, "pending">;
  readonly #toolSettings: (userId: string) => ToolSettings;
  constructor(
    database: AppDatabase,
    generateId: IdGenerator = createUuidV7,
    toolSettings: (userId: string) => ToolSettings,
    runtimes: Pick<SessionRuntimes, "pending">,
    reportParent?: SessionStoreWriteResources["reportParent"],
  ) {
    super(database, generateId);
    this.#resources = [database, generateId];
    this.#reportParent = reportParent;
    this.#toolSettings = toolSettings;
    this.#manualCompactions = new ManualCompactionStore(database, generateId);
    this.#questions = new AskQuestionsStore({
      generateId,
      persistence: createAskQuestionsPersistence(database),
      systemActorId: SYSTEM_ID,
      toolSettings: (_userId, sessionId, executionGeneration) =>
        activeSessionToolSettings(database, sessionId, executionGeneration),
    });
    this.#runtimes = runtimes;
  }
  repairSpawnedSessionLineage(now?: number): SpawnLineageRepairResult {
    return repairSpawnedSessionLineage(this.#database, now);
  }
  recoverSpawnedSessionReservations(now: number): number {
    return recoverSpawnedSessionReservations({
      content: "Session failed: the server restarted during child preparation",
      database: this.#database,
      generateId: this.#resources[1],
      now,
    });
  }
  get #database(): AppDatabase {
    return this.#resources[0];
  }
  #writeResources(workspaceId?: string) {
    const database = this.#database;
    const generateId = this.#resources[1];
    const read = (userId: string, sessionId: string) =>
      this.get(userId, sessionId, workspaceId);
    return {
      database,
      generateId,
      read,
      toolSettings: this.#toolSettings,
      ...(this.#reportParent === undefined
        ? {}
        : { reportParent: this.#reportParent }),
    };
  }
  writeResources(workspaceId?: string) {
    return this.#writeResources(workspaceId);
  }
  #generateId(now: number): string {
    return this.#resources[1](now);
  }
  create(input: CreateAgentSession, now: number): CreateSessionResult {
    return createStoredSession(this.#writeResources(), input, now);
  }
  #spawnIdentity(userId: string, sessionId: string, generation: number) {
    return { generation, sessionId, userId };
  }
  #reservationOptions(userId: string, sessionId: string, generation: number) {
    return {
      database: this.#database,
      identity: this.#spawnIdentity(userId, sessionId, generation),
    };
  }
  prepareSpawnedSession(
    identity: { readonly generation: number; readonly sessionId: string },
    userId: string,
    authority: SessionExecutionAuthority,
    metadata: SpawnedSessionMetadata,
    now: number,
  ) {
    const reservation = this.#spawnIdentity(
      userId,
      identity.sessionId,
      identity.generation,
    );
    return prepareSpawnedSessionReservation({
      authority,
      database: this.#database,
      identity: reservation,
      metadata,
      now,
    });
  }
  claimSpawnedSession(
    userId: string,
    identity: { readonly generation: number; readonly sessionId: string },
    authority: SessionExecutionAuthority,
  ): boolean {
    const options = {
      authority,
      database: this.#database,
      identity: this.#spawnIdentity(
        userId,
        identity.sessionId,
        identity.generation,
      ),
    };
    return claimSpawnedSessionReservation(options);
  }
  discardSpawnedSessionPreparation(
    userId: string,
    sessionId: string,
    generation: number,
    now: number,
  ): boolean {
    return discardSpawnedSessionReservation({
      ...this.#reservationOptions(userId, sessionId, generation),
      now,
    });
  }
  failSpawnedSessionPreparation(
    userId: string,
    sessionId: string,
    generation: number,
    content: string,
    now: number,
  ): boolean {
    return failSpawnedSessionReservation({
      allowClaimed: true,
      content,
      ...this.#reservationOptions(userId, sessionId, generation),
      generateId: this.#resources[1],
      now,
    });
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
  toolSettings(sessionId: string, executionGeneration: number): ToolSettings {
    return activeSessionToolSettings(
      this.#database,
      sessionId,
      executionGeneration,
    );
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
      this.#runtimes.pending.bind(this.#runtimes),
    );
  }
  list(userId: string, workspaceId?: string): readonly AgentSessionSummary[] {
    return listStoredSessions(
      this.#database,
      this.#readPendingQuestions.bind(this),
      userId,
      workspaceId,
      this.#runtimes.pending.bind(this.#runtimes),
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
    replayIdentity?: AnthropicReplayIdentity,
    interrupted = true,
  ): readonly AgentConversationMessage[] {
    return conversationFromInternalMessages(
      withInterruptedInternalToolResults(
        readInternalSessionMessages(this.#database, sessionId),
        interrupted,
      ),
      replayIdentity,
    );
  }
  conversationTruncation(sessionId: string): AgentStepTruncation | undefined {
    return storedConversationTruncation(
      readStoredSessionMessages(this.#database, sessionId),
    );
  }
  protected readRestartSession(userId: string, sessionId: string) {
    return this.get(userId, sessionId);
  }
  protected runtimeWriteResources() {
    return this.#writeResources();
  }
  reassign(
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    now: number,
  ): ReassignSessionResult {
    return reassignStoredSession({
      resources: this.#writeResources(),
      now,
      read: (ownerId, id) => this.get(ownerId, id),
      runnerId,
      sessionId,
      userId,
      workingDirectory,
    });
  }
  #settingContext() {
    return {
      database: this.#database,
      read: (userId: string, sessionId: string, workspaceId?: string) =>
        this.get(userId, sessionId, workspaceId),
    };
  }
  setContextTokenCap(...parameters: SessionContextTokenCapParameters) {
    return setSessionContextTokenCap(this.#settingContext(), ...parameters);
  }
  setAutoCompact(...parameters: SessionCompactionFlagParameters) {
    return setSessionCompactionFlag(
      this.#settingContext(),
      "autoCompact",
      ...parameters,
    );
  }
  setIdleCompact(...parameters: SessionCompactionFlagParameters) {
    return setSessionCompactionFlag(
      this.#settingContext(),
      "idleCompact",
      ...parameters,
    );
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
  manualCompactionPending(sessionId: string, generation: number): boolean {
    return this.#manualCompactions.pending(sessionId, generation);
  }
  scheduleManualCompaction(sessionId: string, generation: number, now: number) {
    return this.#manualCompactions.schedule(sessionId, generation, now);
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
    ...parameters: Parameters<SessionStore["spawnedSessionCallbackDisposition"]>
  ): boolean {
    return this.spawnedSessionCallbackDisposition(...parameters) !== undefined;
  }
  spawnedSessionCallbackDisposition(
    userId: string,
    childId: string,
    childGeneration: number,
    parentId: string,
    parentGeneration: number,
    content: string,
    now: number,
  ): SpawnedReportDisposition | undefined {
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
  activeSpawnedSessionChildren(userId: string, sessionId: string) {
    return activeSpawnedSessionChildren(this.#database, userId, sessionId);
  }
  spawnedSessionChildren(userId: string, sessionId: string): readonly string[] {
    return spawnedSessionChildren(this.#database, userId, sessionId);
  }
  spawnedSessionLink(userId: string, sessionId: string) {
    return spawnedSessionLink(this.#database, userId, sessionId);
  }
  pendingSpawnedSessions(limit?: number): readonly PendingSpawnedSession[] {
    return pendingSpawnedSessions(this.#database, this.get.bind(this), limit);
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
    const current = readStoredSessionGeneration({
      condition: activeSessionCondition({ id: sessionId }),
      database: this.#database,
    });
    if (current === undefined) {
      throw new DOMException("The agent session was stopped", "AbortError");
    }
    return current;
  }
  #current(): CurrentSessionStore {
    return new CurrentSessionStore(this, (sessionId) =>
      this.#currentGeneration(sessionId),
    );
  }
  appendCurrentAgentMessage: CurrentSessionStore["appendAgentMessage"] = (
    ...a
  ) => {
    this.#current().appendAgentMessage(...a);
  };
  appendCurrentErrorMessage: CurrentSessionStore["appendErrorMessage"] = (
    ...a
  ) => {
    this.#current().appendErrorMessage(...a);
  };
  compactCurrentConversation: CurrentSessionStore["compactConversation"] = (
    ...a
  ) => {
    this.#current().compactConversation(...a);
  };
  setCurrentAgentFile: CurrentSessionStore["setAgentFile"] = (...a) => {
    this.#current().setAgentFile(...a);
  };
  updateCurrentUsage: CurrentSessionStore["updateUsage"] = (...a) => {
    this.#current().updateUsage(...a);
  };
  transitionCurrent: CurrentSessionStore["transition"] = (...a) =>
    this.#current().transition(...a);
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
        toolSettings: this.#toolSettings,
      },
      sessionId,
      userId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  }
  failInterrupted(
    now: number,
    active: (id: string, generation: number) => boolean = () => false,
  ) {
    const interrupted = interruptedStoredSessions(this.#database, now);
    for (const session of interrupted) {
      if (active(session.id, session.executionGeneration)) {
        continue;
      }
      if (this.restoreInterruptedRestart(session, now)) {
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
