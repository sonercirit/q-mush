import type { AgentFile } from "../shared/agent-file.ts";

import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
  AgentRecordedMessage,
  AgentStepTruncation,
} from "../shared/agent-loop.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type { AppDatabase } from "../shared/database.ts";
import { type IdGenerator } from "../shared/ids.ts";
import type { SessionHistoryPage } from "../shared/session-history.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { AnthropicReplayIdentity } from "./anthropic-replay-identity.ts";
import { type AskQuestionsStore } from "./ask-questions-store.ts";
import {
  type SessionExecutionAuthority,
  type SessionQueueAuthorization,
} from "./session-execution-authority.ts";
import { type SpawnLineageRepairResult } from "./session-lineage-repair.ts";
import {
  type cancelPendingInput,
  type CancelPendingInputResult,
  type EnqueuePendingInputResult,
  type EnqueuePendingSessionInput,
  type NormalSessionBoundaryResult,
} from "./session-pending-inputs.ts";
import { type SpawnedSessionMetadata } from "./session-spawn-reservation-store.ts";
import {
  type CreateAgentSession,
  type CreateSessionResult,
} from "./session-store-create.ts";
import {
  type SessionStoreForkParameters,
  type SessionStoreForkResult,
} from "./session-store-fork.ts";
import { type QueueSessionResult } from "./session-store-queue.ts";
import { type appendUnknownRestartToolResults } from "./session-store-read.ts";
import { type ReassignSessionResult } from "./session-store-reassignment.ts";
import type { ReportedParentEvent } from "./session-store-resources.ts";
import type { SessionStoreRestarts } from "./session-store-restarts.ts";
import type { SessionStoreRuntime } from "./session-store-runtime.ts";
import type {
  SessionCompactionFlagParameters,
  SessionContextTokenCapParameters,
} from "./session-store-settings.ts";
import type {
  PendingSpawnedSession,
  SpawnedReportDisposition,
  SpawnedSessionLink,
} from "./session-store-spawns.ts";
import type { SpawnedReportParameters } from "./session-store-types.ts";
interface SessionStoreLifecycle {
  failInterrupted(
    now: number,
    active?: (id: string, generation: number) => boolean,
  ): readonly PendingSpawnedSession[];
  repairSpawnedSessionLineage(now?: number): SpawnLineageRepairResult;
  recoverSpawnedSessionReservations(now: number): number;
  writeResources(workspaceId?: string): {
    reportParent?: (userId: string, report: ReportedParentEvent) => void;
    database: AppDatabase;
    generateId: IdGenerator;
    read: (userId: string, sessionId: string) => AgentSessionDetail | undefined;
    toolSettings: (userId: string) => ToolSettings;
  };
}

interface SessionStoreSpawns {
  create(input: CreateAgentSession, now: number): CreateSessionResult;
  prepareSpawnedSession(
    identity: { readonly generation: number; readonly sessionId: string },
    userId: string,
    authority: SessionExecutionAuthority,
    metadata: SpawnedSessionMetadata,
    now: number,
  ): "prepared" | "parent_stale";
  claimSpawnedSession(
    userId: string,
    identity: { readonly generation: number; readonly sessionId: string },
    authority: SessionExecutionAuthority,
  ): boolean;
  discardSpawnedSessionPreparation(
    userId: string,
    sessionId: string,
    generation: number,
    now: number,
  ): boolean;
  failSpawnedSessionPreparation(
    userId: string,
    sessionId: string,
    generation: number,
    content: string,
    now: number,
  ): boolean;
}

interface SessionStoreQueries {
  fork(...parameters: SessionStoreForkParameters): SessionStoreForkResult;
  questions(): AskQuestionsStore;
  toolSettings(sessionId: string, executionGeneration: number): ToolSettings;
  pendingQuestions(
    userId: string,
    sessionId: string,
  ): PendingAskQuestions | null;
  executionIsCurrent(
    userId: string,
    sessionId: string,
    generation: number,
    tool?: AgentSessionToolName,
  ): boolean;
  get(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): AgentSessionDetail | undefined;
  list(userId: string, workspaceId?: string): readonly AgentSessionSummary[];
  history(
    userId: string,
    sessionId: string,
    cursor: string | null,
  ): SessionHistoryPage | undefined;
  conversation(
    sessionId: string,
    replayIdentity?: AnthropicReplayIdentity,
    interrupted?: boolean,
  ): readonly AgentConversationMessage[];
  conversationTruncation(sessionId: string): AgentStepTruncation | undefined;
  reassign(
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    now: number,
  ): ReassignSessionResult;
  setContextTokenCap(
    ...parameters: SessionContextTokenCapParameters
  ): AgentSessionDetail | undefined;
  setAutoCompact(
    ...parameters: SessionCompactionFlagParameters
  ): AgentSessionDetail | undefined;
  setIdleCompact(
    ...parameters: SessionCompactionFlagParameters
  ): AgentSessionDetail | undefined;
}

interface SessionStoreInputs {
  appendUnknownRestartToolResults(
    database: Parameters<typeof appendUnknownRestartToolResults>[0]["database"],
    sessionId: string,
    now: number,
  ): void;
  appendInterruptedRunnerTool(sessionId: string, now: number): void;
  cancelPendingInput(
    options: Omit<Parameters<typeof cancelPendingInput>[0], "database">,
  ): CancelPendingInputResult;
  enqueuePendingInput(
    userId: string,
    sessionId: string,
    input: EnqueuePendingSessionInput,
    now: number,
  ): EnqueuePendingInputResult;
  takeSteeringInputs(
    sessionId: string,
    now: number,
  ): readonly Extract<AgentConversationMessage, { readonly role: "user" }>[];
  manualCompactionPending(sessionId: string, generation: number): boolean;
  scheduleManualCompaction(
    sessionId: string,
    generation: number,
    now: number,
  ): "unavailable" | "already_pending" | "scheduled";
  settleNormalBoundary(
    sessionId: string,
    now: number,
    generation: number,
  ): NormalSessionBoundaryResult;
}

type SessionQueueParameters = readonly [
  userId: string,
  sessionId: string,
  now: number,
  prompt?: { readonly content: string; readonly images: readonly AgentImage[] },
  authorization?: SessionQueueAuthorization,
  workspaceId?: string,
];

interface SessionStoreLineage {
  appendUserMessage(
    userId: string,
    sessionId: string,
    content: string,
    now: number,
  ): boolean;
  appendSpawnedSessionReport(...parameters: SpawnedReportParameters): boolean;
  spawnedSessionCallbackDisposition(
    ...parameters: SpawnedReportParameters
  ): SpawnedReportDisposition | undefined;
  activeSpawnedSessionChildren(
    userId: string,
    sessionId: string,
  ): readonly string[];
  spawnedSessionChildren(userId: string, sessionId: string): readonly string[];
  spawnedSessionLink(
    userId: string,
    sessionId: string,
  ): SpawnedSessionLink | undefined;
  pendingSpawnedSessions(limit?: number): readonly PendingSpawnedSession[];
  queuedSessionOwnerIds(): readonly string[];
  queuedSessions(userId: string): readonly AgentSessionDetail[];
  transitionRuntime(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
    generation: number,
  ): boolean;
  /**
   * Administrative/test helper that intentionally targets the current generation.
   * Runtime code must use the generation-required methods above.
   */
  appendCurrentAgentMessage: (
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ) => void;
  appendCurrentErrorMessage: (
    sessionId: string,
    content: string,
    now: number,
  ) => void;
  compactCurrentConversation: (
    sessionId: string,
    summary: string,
    usage: AgentSessionUsageUpdate,
    now: number,
  ) => void;
  setCurrentAgentFile: (
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ) => void;
  updateCurrentUsage: (
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
  ) => void;
  transitionCurrent: (
    sessionId: string,
    status: "failed" | "running" | "idle",
    now: number,
  ) => boolean;
  stop(userId: string, sessionId: string, now: number): boolean;
  queue(...parameters: SessionQueueParameters): QueueSessionResult;
}

export interface SessionStore
  extends
    SessionStoreRestarts,
    SessionStoreRuntime,
    SessionStoreLifecycle,
    SessionStoreSpawns,
    SessionStoreQueries,
    SessionStoreInputs,
    SessionStoreLineage {}
