import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { createUuidV7, SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { AnthropicReplayIdentity } from "./anthropic-replay-identity.ts";
import { createAskQuestionsPersistence } from "./ask-questions-persistence.ts";
import { createAskQuestionsStore } from "./ask-questions-store.ts";
import {
  createCurrentSessionStore,
  type CurrentSessionStore,
} from "./session-current-store.ts";
import { sessionExecutionIsCurrent } from "./session-execution-authority.ts";
import { readStoredSessionHistory } from "./session-history-store.ts";
import { repairSpawnedSessionLineage } from "./session-lineage-repair.ts";
import { createManualCompactionStore } from "./session-manual-compaction-store.ts";
import {
  cancelPendingInput,
  enqueuePendingInput,
  settleNormalSessionBoundary,
  takeSteeringInputs,
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
} from "./session-spawn-reservation-store.ts";
import { createStoredSession } from "./session-store-create.ts";
import {
  forkStoredSessionFromSource,
  type SessionStoreForkResult,
} from "./session-store-fork.ts";
import type { SessionStore } from "./session-store-interface.ts";
import { activeSessionCondition } from "./session-store-persistence.ts";
import {
  listStoredSessions,
  readStoredSessionDetail,
} from "./session-store-queries.ts";
import { queueStoredSession } from "./session-store-queue.ts";
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
  generatedSessionId,
  sessionSpawnIdentity,
  sessionSpawnReservationOptions,
} from "./session-store-spawn-options.ts";
import {
  activeSpawnedSessionChildren,
  appendSpawnedSessionReport,
  pendingSpawnedSessions,
  spawnedSessionChildren,
  spawnedSessionLink,
  type SpawnedReportDisposition,
} from "./session-store-spawns.ts";
import { readStoredSessionGeneration } from "./session-store-state.ts";
import {
  stopStoredSession,
  transitionSessionRuntime,
} from "./session-store-transitions.ts";
import type { SpawnedReportParameters } from "./session-store-types.ts";
import { appendSessionUserMessage } from "./session-store-values.ts";
import { activeSessionToolSettings } from "./session-turn-store.ts";
export type { SessionStore } from "./session-store-interface.ts";

export function createSessionStore(
  database: AppDatabase,
  generateId: IdGenerator = createUuidV7,
  readToolSettings: (userId: string) => ToolSettings,
  runtimes: Pick<SessionRuntimes, "pending">,
  reportParent?: SessionStoreWriteResources["reportParent"],
): SessionStore {
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
  const generateSessionId = generatedSessionId(generateId);
  const readPendingQuestions = (userId: string, sessionId: string) =>
    questionsStore.pending(userId, sessionId);
  const readSession = (
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ) => store.get(userId, sessionId, workspaceId);
  const settingContext = () =>
    createSessionSettingContext(database, readSession);
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
  const store: SessionStore = {
    repairSpawnedSessionLineage(now?: number) {
      return repairSpawnedSessionLineage(database, now);
    },
    recoverSpawnedSessionReservations(now) {
      return recoverSpawnedSessionReservations({
        content:
          "Session failed: the server restarted during child preparation",
        database,
        generateId,
        now,
      });
    },
    writeResources(workspaceId?: string) {
      return writeResourcesInternal(workspaceId);
    },
    create(input, now) {
      return createStoredSession(writeResourcesInternal(), input, now);
    },
    prepareSpawnedSession(
      identity: { readonly generation: number; readonly sessionId: string },
      userId,
      authority,
      metadata,
      now,
    ) {
      const reservation = sessionSpawnIdentity(
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
      userId,
      identity: { readonly generation: number; readonly sessionId: string },
      authority,
    ) {
      const options = {
        authority,
        database: database,
        identity: sessionSpawnIdentity(
          userId,
          identity.sessionId,
          identity.generation,
        ),
      };
      return claimSpawnedSessionReservation(options);
    },
    discardSpawnedSessionPreparation(userId, sessionId, generation, now) {
      return discardSpawnedSessionReservation({
        ...sessionSpawnReservationOptions(
          database,
          userId,
          sessionId,
          generation,
        ),
        now,
      });
    },
    failSpawnedSessionPreparation(userId, sessionId, generation, content, now) {
      return failSpawnedSessionReservation({
        allowClaimed: true,
        content,
        ...sessionSpawnReservationOptions(
          database,
          userId,
          sessionId,
          generation,
        ),
        generateId: generateId,
        now,
      });
    },
    fork(...parameters): SessionStoreForkResult {
      return forkStoredSessionFromSource(
        writeResourcesInternal(parameters[3]),
        ...parameters,
      );
    },
    questions() {
      return questionsStore;
    },
    toolSettings(sessionId, executionGeneration) {
      return activeSessionToolSettings(
        database,
        sessionId,
        executionGeneration,
      );
    },
    pendingQuestions(userId, sessionId) {
      return readPendingQuestions(userId, sessionId);
    },
    executionIsCurrent(
      userId,
      sessionId,
      generation,
      tool?: AgentSessionToolName,
    ) {
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
    get(userId, sessionId, workspaceId?: string) {
      return readStoredSessionDetail(
        database,
        readPendingQuestions.bind(this),
        userId,
        sessionId,
        workspaceId,
        runtimes.pending.bind(runtimes),
      );
    },
    list(userId, workspaceId?: string) {
      return listStoredSessions(
        database,
        readPendingQuestions.bind(this),
        userId,
        workspaceId,
        runtimes.pending.bind(runtimes),
      );
    },
    history(userId, sessionId, cursor) {
      return readStoredSessionHistory(database, userId, {
        cursor,
        sessionId,
      });
    },
    conversation(
      sessionId,
      replayIdentity?: AnthropicReplayIdentity,
      interrupted = true,
    ) {
      return conversationFromInternalMessages(
        withInterruptedInternalToolResults(
          readInternalSessionMessages(database, sessionId),
          interrupted,
        ),
        replayIdentity,
      );
    },
    conversationTruncation(sessionId) {
      return storedConversationTruncation(
        readStoredSessionMessages(database, sessionId),
      );
    },
    reassign(userId, sessionId, runnerId, workingDirectory, now) {
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
      sessionId,
      now,
    ) {
      appendUnknownRestartToolResults({
        database,
        generateId: generateId,
        now,
        sessionId,
      });
    },
    appendInterruptedRunnerTool(sessionId, now) {
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
    enqueuePendingInput(userId, sessionId, input, now) {
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
      sessionId,
      now,
    ): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[] {
      return takeSteeringInputs({ database: database, now, sessionId });
    },
    manualCompactionPending(sessionId, generation) {
      return manualCompactions.pending(sessionId, generation);
    },
    scheduleManualCompaction(sessionId, generation, now) {
      return manualCompactions.schedule(sessionId, generation, now);
    },
    settleNormalBoundary(sessionId, now, generation) {
      return settleNormalSessionBoundary({
        database: database,
        generation,
        now,
        sessionId,
      });
    },
    appendUserMessage(userId, sessionId, content, now) {
      return appendSessionUserMessage({
        content,
        now,
        resources: { database: database, generateId: generateId },
        sessionId,
        userId,
      });
    },
    appendSpawnedSessionReport(...parameters: SpawnedReportParameters) {
      return spawnedReportDisposition(...parameters) !== undefined;
    },
    spawnedSessionCallbackDisposition(...parameters: SpawnedReportParameters) {
      return spawnedReportDisposition(...parameters);
    },
    activeSpawnedSessionChildren(userId, sessionId) {
      return activeSpawnedSessionChildren(database, userId, sessionId);
    },
    spawnedSessionChildren(userId, sessionId) {
      return spawnedSessionChildren(database, userId, sessionId);
    },
    spawnedSessionLink(userId, sessionId) {
      return spawnedSessionLink(database, userId, sessionId);
    },
    pendingSpawnedSessions(limit?: number) {
      return pendingSpawnedSessions(
        database,
        (userId, sessionId) => store.get(userId, sessionId),
        limit,
      );
    },
    queuedSessionOwnerIds() {
      return queuedSessionOwnerIds(database);
    },
    queuedSessions(userId): readonly AgentSessionDetail[] {
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
      sessionId,
      status: "failed" | "idle" | "running",
      now,
      generation,
    ) {
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
    stop(userId, sessionId, now) {
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
    queue(...[userId, sessionId, now, prompt, authorization, workspaceId]) {
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
    failInterrupted(now, active = () => false) {
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
