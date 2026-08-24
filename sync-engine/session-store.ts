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
import {
  createAskQuestionsStore,
  type AskQuestionsStore,
} from "./ask-questions-store.ts";
import {
  createCurrentSessionStore,
  type CurrentSessionStore,
} from "./session-current-store.ts";
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
import { createManualCompactionStore } from "./session-manual-compaction-store.ts";
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
import { createSessionStoreRestarts } from "./session-store-restarts.ts";
import { createSessionStoreRuntime } from "./session-store-runtime.ts";
import {
  createSessionSettingContext,
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
type SpawnedReportParameters = readonly [
  userId: string,
  childId: string,
  childGeneration: number,
  parentId: string,
  parentGeneration: number,
  content: string,
  now: number,
];
export function createSessionStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
  readToolSettings: (userId: string) => ToolSettings,
  runtimes: Pick<SessionRuntimes, "pending">,
  reportParent?: SessionStoreWriteResources["reportParent"],
) {
  const writeResourcesInternal = (workspaceId?: string) => {
    const read = (userId: string, sessionId: string) =>
      store.get(userId, sessionId, workspaceId);
    return {
      database,
      generateId,
      read,
      toolSettings: readToolSettings,
      ...(reportParent === undefined ? {} : { reportParent }),
    };
  };
  const runtime = createSessionStoreRuntime(writeResourcesInternal);
  const restarts = createSessionStoreRestarts({
    appendUnknownToolResults: (transaction, sessionId, now) => {
      store.appendUnknownRestartToolResults(transaction, sessionId, now);
    },
    database,
    generateId,
    read: (userId, sessionId) => store.get(userId, sessionId),
  });
  const manualCompactions = createManualCompactionStore(database, generateId);
  const questionsStore = createAskQuestionsStore({
    generateId,
    persistence: createAskQuestionsPersistence(database),
    systemActorId: SYSTEM_ID,
    toolSettings: (_userId, sessionId, executionGeneration) =>
      activeSessionToolSettings(database, sessionId, executionGeneration),
  });
  const generateSessionId = (now: number) => generateId(now);
  const spawnIdentity = (
    userId: string,
    sessionId: string,
    generation: number,
  ) => ({ generation, sessionId, userId });
  const reservationOptions = (
    userId: string,
    sessionId: string,
    generation: number,
  ) => ({ database, identity: spawnIdentity(userId, sessionId, generation) });
  const readPendingQuestions = (userId: string, sessionId: string) =>
    questionsStore.pending(userId, sessionId);
  const settingContext = () =>
    createSessionSettingContext(
      database,
      (userId: string, sessionId: string, workspaceId?: string) =>
        store.get(userId, sessionId, workspaceId),
    );
  const currentGeneration = (sessionId: string): number => {
    const current = readStoredSessionGeneration({
      condition: activeSessionCondition({ id: sessionId }),
      database,
    });
    if (current === undefined)
      throw new DOMException("The agent session was stopped", "AbortError");
    return current;
  };
  const currentStore = (): CurrentSessionStore =>
    createCurrentSessionStore(store, currentGeneration);
  const spawnedReportDisposition = (
    ...[
      userId,
      childId,
      childGeneration,
      parentId,
      parentGeneration,
      content,
      now,
    ]: SpawnedReportParameters
  ): SpawnedReportDisposition | undefined =>
    appendSpawnedSessionReport({
      childGeneration,
      childId,
      content,
      database,
      generateId,
      now,
      parentGeneration,
      parentId,
      userId,
    });
  const store = {
    repairSpawnedSessionLineage(now?: number): SpawnLineageRepairResult {
      return repairSpawnedSessionLineage(database, now);
    },
    recoverSpawnedSessionReservations(now: number): number {
      return recoverSpawnedSessionReservations({
        content:
          "Session failed: the server restarted during child preparation",
        database: database,
        generateId: generateId,
        now,
      });
    },
    writeResources(workspaceId?: string) {
      return writeResourcesInternal(workspaceId);
    },
    create(input: CreateAgentSession, now: number): CreateSessionResult {
      return createStoredSession(writeResourcesInternal(), input, now);
    },
    prepareSpawnedSession(
      identity: { readonly generation: number; readonly sessionId: string },
      userId: string,
      authority: SessionExecutionAuthority,
      metadata: SpawnedSessionMetadata,
      now: number,
    ) {
      const reservation = spawnIdentity(
        userId,
        identity.sessionId,
        identity.generation,
      );
      return prepareSpawnedSessionReservation({
        authority,
        database: database,
        identity: reservation,
        metadata,
        now,
      });
    },
    claimSpawnedSession(
      userId: string,
      identity: { readonly generation: number; readonly sessionId: string },
      authority: SessionExecutionAuthority,
    ): boolean {
      const options = {
        authority,
        database: database,
        identity: spawnIdentity(
          userId,
          identity.sessionId,
          identity.generation,
        ),
      };
      return claimSpawnedSessionReservation(options);
    },
    discardSpawnedSessionPreparation(
      userId: string,
      sessionId: string,
      generation: number,
      now: number,
    ): boolean {
      return discardSpawnedSessionReservation({
        ...reservationOptions(userId, sessionId, generation),
        now,
      });
    },
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
        ...reservationOptions(userId, sessionId, generation),
        generateId: generateId,
        now,
      });
    },
    fork(...parameters: SessionStoreForkParameters): SessionStoreForkResult {
      return forkStoredSessionFromSource(
        writeResourcesInternal(parameters[3]),
        ...parameters,
      );
    },
    questions(): AskQuestionsStore {
      return questionsStore;
    },
    toolSettings(sessionId: string, executionGeneration: number): ToolSettings {
      return activeSessionToolSettings(
        database,
        sessionId,
        executionGeneration,
      );
    },
    pendingQuestions(
      userId: string,
      sessionId: string,
    ): PendingAskQuestions | null {
      return readPendingQuestions(userId, sessionId);
    },
    executionIsCurrent(
      userId: string,
      sessionId: string,
      generation: number,
      tool?: AgentSessionToolName,
    ): boolean {
      return sessionExecutionIsCurrent(
        database,
        {
          generation,
          sessionId,
          ...(tool === undefined ? {} : { tool }),
        },
        userId,
      );
    },
    get(
      userId: string,
      sessionId: string,
      workspaceId?: string,
    ): AgentSessionDetail | undefined {
      return readStoredSessionDetail(
        database,
        readPendingQuestions.bind(this),
        userId,
        sessionId,
        workspaceId,
        runtimes.pending.bind(runtimes),
      );
    },
    list(userId: string, workspaceId?: string): readonly AgentSessionSummary[] {
      return listStoredSessions(
        database,
        readPendingQuestions.bind(this),
        userId,
        workspaceId,
        runtimes.pending.bind(runtimes),
      );
    },
    history(
      userId: string,
      sessionId: string,
      cursor: string | null,
    ): SessionHistoryPage | undefined {
      return readStoredSessionHistory(database, userId, {
        cursor,
        sessionId,
      });
    },
    conversation(
      sessionId: string,
      replayIdentity?: AnthropicReplayIdentity,
      interrupted = true,
    ): readonly AgentConversationMessage[] {
      return conversationFromInternalMessages(
        withInterruptedInternalToolResults(
          readInternalSessionMessages(database, sessionId),
          interrupted,
        ),
        replayIdentity,
      );
    },
    conversationTruncation(sessionId: string): AgentStepTruncation | undefined {
      return storedConversationTruncation(
        readStoredSessionMessages(database, sessionId),
      );
    },
    reassign(
      userId: string,
      sessionId: string,
      runnerId: string,
      workingDirectory: string,
      now: number,
    ): ReassignSessionResult {
      return reassignStoredSession({
        resources: writeResourcesInternal(),
        now,
        read: (ownerId, id) => store.get(ownerId, id),
        runnerId,
        sessionId,
        userId,
        workingDirectory,
      });
    },
    setContextTokenCap(...parameters: SessionContextTokenCapParameters) {
      return setSessionContextTokenCap(settingContext(), ...parameters);
    },
    setAutoCompact(...parameters: SessionCompactionFlagParameters) {
      return setSessionCompactionFlag(
        settingContext(),
        "autoCompact",
        ...parameters,
      );
    },
    setIdleCompact(...parameters: SessionCompactionFlagParameters) {
      return setSessionCompactionFlag(
        settingContext(),
        "idleCompact",
        ...parameters,
      );
    },
    appendUnknownRestartToolResults(
      database: Parameters<
        typeof appendUnknownRestartToolResults
      >[0]["database"],
      sessionId: string,
      now: number,
    ): void {
      appendUnknownRestartToolResults({
        database,
        generateId: generateId,
        now,
        sessionId,
      });
    },
    appendInterruptedRunnerTool(sessionId: string, now: number): void {
      appendInterruptedRunnerToolResult({
        database: database,
        generateId: generateId,
        now,
        sessionId,
      });
    },
    cancelPendingInput(
      options: Omit<Parameters<typeof cancelPendingInput>[0], "database">,
    ) {
      return cancelPendingInput({ ...options, database: database });
    },
    enqueuePendingInput(
      userId: string,
      sessionId: string,
      input: EnqueuePendingSessionInput,
      now: number,
    ): EnqueuePendingInputResult {
      return enqueuePendingInput({
        database: database,
        generateId: generateId,
        input,
        now,
        sessionId,
        userId,
      });
    },
    takeSteeringInputs(
      sessionId: string,
      now: number,
    ): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
      return takeSteeringInputs({ database: database, now, sessionId });
    },
    manualCompactionPending(sessionId: string, generation: number): boolean {
      return manualCompactions.pending(sessionId, generation);
    },
    scheduleManualCompaction(
      sessionId: string,
      generation: number,
      now: number,
    ) {
      return manualCompactions.schedule(sessionId, generation, now);
    },
    settleNormalBoundary(sessionId: string, now: number, generation: number) {
      return settleNormalSessionBoundary({
        database: database,
        generation,
        now,
        sessionId,
      });
    },
    appendUserMessage(
      userId: string,
      sessionId: string,
      content: string,
      now: number,
    ): boolean {
      return appendSessionUserMessage({
        content,
        now,
        resources: { database: database, generateId: generateId },
        sessionId,
        userId,
      });
    },
    appendSpawnedSessionReport(
      ...parameters: SpawnedReportParameters
    ): boolean {
      return spawnedReportDisposition(...parameters) !== undefined;
    },
    spawnedSessionCallbackDisposition(
      ...parameters: SpawnedReportParameters
    ): SpawnedReportDisposition | undefined {
      return spawnedReportDisposition(...parameters);
    },
    activeSpawnedSessionChildren(userId: string, sessionId: string) {
      return activeSpawnedSessionChildren(database, userId, sessionId);
    },
    spawnedSessionChildren(
      userId: string,
      sessionId: string,
    ): readonly string[] {
      return spawnedSessionChildren(database, userId, sessionId);
    },
    spawnedSessionLink(userId: string, sessionId: string) {
      return spawnedSessionLink(database, userId, sessionId);
    },
    pendingSpawnedSessions(limit?: number): readonly PendingSpawnedSession[] {
      return pendingSpawnedSessions(
        database,
        (userId: string, sessionId: string) => store.get(userId, sessionId),
        limit,
      );
    },
    queuedSessionOwnerIds(): readonly string[] {
      return queuedSessionOwnerIds(database);
    },
    queuedSessions(userId: string): readonly AgentSessionDetail[] {
      const awaitingAnsweredLaunch = new Set(
        questionsStore
          .recoverable()
          .filter((request) => request.userId === userId)
          .map((request) => request.sessionId),
      );
      return queuedSessionDetails(database, userId, (ownerId, sessionId) =>
        store.get(ownerId, sessionId),
      ).filter(({ id }) => !awaitingAnsweredLaunch.has(id));
    },
    transitionRuntime(
      sessionId: string,
      status: "failed" | "idle" | "running",
      now: number,
      generation: number,
    ): boolean {
      return transitionSessionRuntime({
        generation,
        now,
        resources: { database: database },
        sessionId,
        status,
      });
    },
    /**
     * Administrative/test helper that intentionally targets the current generation.
     * Runtime code must use the generation-required methods above.
     */
    appendCurrentAgentMessage: (
      ...parameters: Parameters<CurrentSessionStore["appendAgentMessage"]>
    ) => {
      currentStore().appendAgentMessage(...parameters);
    },
    appendCurrentErrorMessage: (
      ...parameters: Parameters<CurrentSessionStore["appendErrorMessage"]>
    ) => {
      currentStore().appendErrorMessage(...parameters);
    },
    compactCurrentConversation: (
      ...parameters: Parameters<CurrentSessionStore["compactConversation"]>
    ) => {
      currentStore().compactConversation(...parameters);
    },
    setCurrentAgentFile: (
      ...parameters: Parameters<CurrentSessionStore["setAgentFile"]>
    ) => {
      currentStore().setAgentFile(...parameters);
    },
    updateCurrentUsage: (
      ...parameters: Parameters<CurrentSessionStore["updateUsage"]>
    ) => {
      currentStore().updateUsage(...parameters);
    },
    transitionCurrent: (
      ...parameters: Parameters<CurrentSessionStore["transition"]>
    ) => currentStore().transition(...parameters),
    stop(userId: string, sessionId: string, now: number): boolean {
      if (questionsStore.pending(userId, sessionId) !== null) {
        return questionsStore.stop(userId, sessionId, now);
      }
      return stopStoredSession({
        now,
        resources: { database: database },
        sessionId,
        userId,
      });
    },
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
          database: database,
          generateId: generateId,
          read: (ownerId, id) => store.get(ownerId, id, workspaceId),
          toolSettings: readToolSettings,
        },
        sessionId,
        userId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
    },
    ...runtime,
    ...restarts,
    failInterrupted(
      now: number,
      active: (id: string, generation: number) => boolean = () => false,
    ) {
      const interrupted = interruptedStoredSessions(database, now);
      for (const session of interrupted) {
        if (active(session.id, session.executionGeneration)) {
          continue;
        }
        if (restarts.restoreInterruptedRestart(session, now)) {
          continue;
        }
        failInterruptedStoredSession(
          database,
          session,
          generateSessionId(now),
          now,
        );
      }
      return store.pendingSpawnedSessions();
    },
  };
  return store;
}

export interface SessionStore extends ReturnType<typeof createSessionStore> {
  readonly __sessionStore?: never;
}
