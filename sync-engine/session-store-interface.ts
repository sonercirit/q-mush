import type { AgentImage } from "../shared/agent-images.ts";
import type {
  AgentConversationMessage,
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
  cancelPendingInput,
  type EnqueuePendingInputResult,
  type EnqueuePendingSessionInput,
} from "./session-pending-inputs.ts";
import { type SpawnedSessionMetadata } from "./session-spawn-reservation-store.ts";
import {
  type CreateAgentSession,
  type CreateSessionResult,
} from "./session-store-create.ts";
import { type SessionStoreForkResult } from "./session-store-fork.ts";
import { type QueueSessionResult } from "./session-store-queue.ts";
import { appendUnknownRestartToolResults } from "./session-store-read.ts";
import { type ReassignSessionResult } from "./session-store-reassignment.ts";
import {
  type PendingSpawnedSession,
  type SpawnedReportDisposition,
} from "./session-store-spawns.ts";
export interface SessionStore {
  failInterrupted(
    now: number,
    active?: (id: string, generation: number) => boolean,
  ): readonly PendingSpawnedSession[];
  claimRestartHandoff: (
    userId: string,
    identity: import("./session-restart-store.ts").RestartHandoffIdentity,
    now: number,
  ) => AgentSessionDetail | undefined;
  failInvalidRestartHandoff: (
    invalid: import("./session-restart-store.ts").InvalidRestartSession,
    error: string,
    now: number,
  ) => boolean;
  failRestartHandoff: import("./session-restart-store.ts").RestartHandoffStore["failQueued"];
  invalidRestartHandoffs: import("./session-restart-store.ts").RestartHandoffStore["invalid"];
  pauseQueuedForRestart: import("./session-restart-store.ts").RestartHandoffStore["pauseQueued"];
  pauseRunningForRestart: import("./session-restart-store.ts").RestartHandoffStore["pauseRunning"];
  pendingRestartHandoffs: import("./session-restart-store.ts").RestartHandoffStore["pending"];
  restoreInterruptedRestart: import("./session-restart-store.ts").RestartHandoffStore["restoreInterrupted"];
  restoreRestartHandoff: import("./session-restart-store.ts").RestartHandoffStore["restore"];
  settleRestartHandoff: import("./session-restart-store.ts").RestartHandoffStore["settle"];
  appendRuntimeAgentMessages: (
    ...parameters: import("./session-runtime-write-options.ts").RuntimeAppendMessageParameters
  ) => void;
  appendRuntimeErrorMessage(
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ): void;
  commitRuntimeTerminal: (
    ...parameters: import("./session-runtime-write-options.ts").RuntimeTerminalMessageParameters
  ) => void;
  compactRuntimeConversation: (
    ...parameters: import("./session-runtime-write-options.ts").RuntimeCompactionParameters
  ) => void;
  compactRuntimeTerminal: (
    ...parameters: readonly [
      ...import("./session-runtime-write-options.ts").RuntimeCompactionParameters,
      restartHandoff:
        import("./session-restart-store.ts").RestartHandoff | null,
    ]
  ) => void;
  markRuntimeStepStart: (
    sessionId: string,
    now: number,
    generation: number,
  ) => void;
  setRuntimeAgentFile: (
    sessionId: string,
    agentFile: import("../shared/agent-file.ts").AgentFile | null,
    now: number,
    generation: number,
  ) => void;
  setRuntimeModelMetadata: (
    sessionId: string,
    credentialId: string,
    metadata: import("./session-store-runtime.ts").RuntimeModelMetadata,
    now: number,
    generation: number,
  ) => void;
  settleRuntimeFailure(
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ): boolean;
  updateRuntimeUsage: (
    sessionId: string,
    input: import("../shared/session-model.ts").AgentSessionUsageUpdate,
    now: number,
    generation: number,
  ) => void;
  repairSpawnedSessionLineage(now?: number): SpawnLineageRepairResult;
  recoverSpawnedSessionReservations(now: number): number;
  writeResources(workspaceId?: string): {
    reportParent?: (
      userId: string,
      report: import("./session-store-resources.ts").ReportedParentEvent,
    ) => void;
    database: AppDatabase;
    generateId: IdGenerator;
    read: (userId: string, sessionId: string) => AgentSessionDetail | undefined;
    toolSettings: (userId: string) => ToolSettings;
  };
  create(input: CreateAgentSession, now: number): CreateSessionResult;
  prepareSpawnedSession(
    identity: {
      readonly generation: number;
      readonly sessionId: string;
    },
    userId: string,
    authority: SessionExecutionAuthority,
    metadata: SpawnedSessionMetadata,
    now: number,
  ): "prepared" | "parent_stale";
  claimSpawnedSession(
    userId: string,
    identity: {
      readonly generation: number;
      readonly sessionId: string;
    },
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
  fork(
    userId: string,
    sourceSessionId: string,
    forkPointMessageId: string,
    workspaceId: string,
    now: number,
    configuration?:
      | Pick<
          CreateAgentSession,
          | "credentialId"
          | "model"
          | "provider"
          | "reasoningEffort"
          | "providerPricing"
          | "openRouterProviderTag"
          | "adaptiveThinking"
          | "maxContextTokens"
          | "maxOutputTokens"
        >
      | undefined,
  ): SessionStoreForkResult;
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
    userId: string,
    sessionId: string,
    cap: number | null,
    now: number,
    workspaceId?: string | undefined,
  ): AgentSessionDetail | undefined;
  setAutoCompact(
    userId: string,
    sessionId: string,
    enabled: boolean,
    now: number,
    workspaceId?: string | undefined,
  ): AgentSessionDetail | undefined;
  setIdleCompact(
    userId: string,
    sessionId: string,
    enabled: boolean,
    now: number,
    workspaceId?: string | undefined,
  ): AgentSessionDetail | undefined;
  appendUnknownRestartToolResults(
    database: Parameters<typeof appendUnknownRestartToolResults>[0]["database"],
    sessionId: string,
    now: number,
  ): void;
  appendInterruptedRunnerTool(sessionId: string, now: number): void;
  cancelPendingInput(
    options: Omit<Parameters<typeof cancelPendingInput>[0], "database">,
  ): import("./session-pending-inputs.ts").CancelPendingInputResult;
  enqueuePendingInput(
    userId: string,
    sessionId: string,
    input: EnqueuePendingSessionInput,
    now: number,
  ): EnqueuePendingInputResult;
  takeSteeringInputs(
    sessionId: string,
    now: number,
  ): readonly Extract<
    AgentConversationMessage,
    {
      readonly role: "user";
    }
  >[];
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
  ): import("./session-pending-inputs.ts").NormalSessionBoundaryResult;
  appendUserMessage(
    userId: string,
    sessionId: string,
    content: string,
    now: number,
  ): boolean;
  appendSpawnedSessionReport(
    userId: string,
    childId: string,
    childGeneration: number,
    parentId: string,
    parentGeneration: number,
    content: string,
    now: number,
  ): boolean;
  spawnedSessionCallbackDisposition(
    userId: string,
    childId: string,
    childGeneration: number,
    parentId: string,
    parentGeneration: number,
    content: string,
    now: number,
  ): SpawnedReportDisposition | undefined;
  activeSpawnedSessionChildren(
    userId: string,
    sessionId: string,
  ): readonly string[];
  spawnedSessionChildren(userId: string, sessionId: string): readonly string[];
  spawnedSessionLink(
    userId: string,
    sessionId: string,
  ): import("./session-store-spawns.ts").SpawnedSessionLink | undefined;
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
    message: import("../shared/agent-loop.ts").AgentRecordedMessage,
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
    usage: import("../shared/session-model.ts").AgentSessionUsageUpdate,
    now: number,
  ) => void;
  setCurrentAgentFile: (
    sessionId: string,
    agentFile: import("../shared/agent-file.ts").AgentFile | null,
    now: number,
  ) => void;
  updateCurrentUsage: (
    sessionId: string,
    input: import("../shared/session-model.ts").AgentSessionUsageUpdate,
    now: number,
  ) => void;
  transitionCurrent: (
    sessionId: string,
    status: "failed" | "running" | "idle",
    now: number,
  ) => boolean;
  stop(userId: string, sessionId: string, now: number): boolean;
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
  ): QueueSessionResult;
}
