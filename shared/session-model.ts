import type { AgentAttachment } from "./agent-attachments.ts";
import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type { AgentFile } from "./agent-file.ts";
import type { AgentTokenUsage, AgentToolCall } from "./agent-loop.ts";
import type { AgentSessionToolName } from "./agent-tools.ts";
import type { PendingAskQuestions } from "./ask-questions.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import type { ProviderModelPricing } from "./provider-model-pricing.ts";
import type { RunnerExecutionEnvironment } from "./runner-command-broker.ts";
import type { SessionPendingInputContent } from "./session-pending-input.ts";
import type { SessionRunStepTiming } from "./session-timing.ts";
import type { AgentTokenUsageSummary } from "./session-token-usage.ts";

export const AGENT_SESSION_STATUSES = [
  "queued",
  "running",
  "paused",
  "idle",
  "completed",
  "stopped",
  "failed",
] as const;

export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export type RestartHandoffRequester = "runner" | "server";
export type RestartHandoffOperation =
  "agent" | "compact" | "compact_and_continue";

export interface RestartHandoff {
  readonly executionGeneration: number;
  readonly operation: RestartHandoffOperation;
  readonly pendingInput: readonly [];
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

export function normalSessionCompletionStatus(
  session: Readonly<{
    parentExecutionGeneration: number | null | undefined;
  }>,
): "completed" | "idle" {
  return session.parentExecutionGeneration == null ? "idle" : "completed";
}

export type AgentSessionCostBasis = "estimated" | "none" | "reported";

export type AgentSessionPendingInputKind = "follow_up" | "steer";

export interface AgentSessionPendingInput extends SessionPendingInputContent {
  readonly attachments?: SessionPendingInputContent["images"];
  readonly createdAt: number;
  readonly id: string;
}

export interface AgentSessionUsageUpdate {
  readonly contextTokens: number | null;
  readonly costBasis: Exclude<AgentSessionCostBasis, "none"> | null;
  readonly costUsd: number | null;
  readonly tokenUsage?: AgentTokenUsage | null;
}

export const AGENT_SESSION_MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
  "thinking",
  "system",
  "error",
  "compaction_request",
] as const;

type AgentSessionMessageRole = (typeof AGENT_SESSION_MESSAGE_ROLES)[number];

export interface AttachmentContentFields {
  readonly attachments?: readonly AgentAttachment[];
  readonly images: readonly AgentAttachment[];
}

export interface AgentSessionMessage extends AttachmentContentFields {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly role: AgentSessionMessageRole;
  readonly tokenUsage?: AgentTokenUsage | null;
  readonly toolCallId: string | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly toolName: string | null;
  readonly turnId?: string | null;
}

export type SessionRuntimePendingComponent =
  | "engine_tool"
  | "provider_admission"
  | "provider_request"
  | "runner_command"
  | "startup";

export interface SessionRuntimePending {
  readonly component: SessionRuntimePendingComponent;
  readonly since: number;
}

export interface AgentSessionSummary extends SessionRunStepTiming<number> {
  readonly adaptiveThinking: boolean | null;
  readonly agentFilePath: string | null;
  readonly autoCompact: boolean;
  readonly costBasis: AgentSessionCostBasis;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly credentialId: string;
  readonly currentContextTokens: number;
  readonly executionEnvironment: RunnerExecutionEnvironment;
  readonly generation: number;
  readonly hasOlderSegments: boolean;
  readonly id: string;
  readonly idleCompact: boolean;
  readonly maxContextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly userContextTokenCap: number | null;
  readonly model: string;
  readonly openRouterProviderTag: string | null;
  readonly parentExecutionGeneration: number | null;
  readonly parentSessionId: string | null;
  readonly provider: ProviderId;
  readonly providerPricing: ProviderModelPricing | null;
  readonly pendingQuestions: PendingAskQuestions | null;
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly restartHandoff: RestartHandoff | null;
  readonly runtimePending: SessionRuntimePending | null;
  readonly runnerId: string;
  readonly runnerRequired: boolean;
  readonly status: AgentSessionStatus;
  readonly title: string;
  readonly tools: readonly AgentSessionToolName[];
  readonly updatedAt: number;
  readonly workingDirectory: string;
  readonly workspaceId: string;
}

export interface AgentSessionTurn {
  readonly boundaryMessageId: string | null;
  readonly endedAt: number | null;
  readonly executionGeneration: number;
  readonly id: string;
  readonly startedAt: number;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  readonly agentFile: AgentFile | null;
  readonly messages: readonly AgentSessionMessage[];
  readonly modelContextTokens: number | null;
  readonly pendingInputs: readonly AgentSessionPendingInput[];
  readonly segmentTokenUsage?: AgentTokenUsageSummary;
  readonly tokenUsage?: AgentTokenUsageSummary;
  readonly turns?: readonly AgentSessionTurn[];
}
