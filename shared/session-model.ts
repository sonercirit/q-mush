import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type { AgentFile } from "./agent-file.ts";
import type { AgentImage } from "./agent-images.ts";
import type { AgentToolCall } from "./agent-loop.ts";
import type { AgentSessionToolName } from "./agent-tools.ts";
import type { PendingAskQuestions } from "./ask-questions.ts";
import type { ProviderId } from "./provider-credential-store.ts";
import type { ProviderModelPricing } from "./provider-model-pricing.ts";

export type AgentSessionStatus =
  "queued" | "running" | "waiting" | "idle" | "stopped" | "failed";

export type AgentSessionCostBasis = "estimated" | "none" | "reported";

export interface AgentSessionUsageUpdate {
  readonly contextTokens: number | null;
  readonly costBasis: Exclude<AgentSessionCostBasis, "none"> | null;
  readonly costUsd: number | null;
}

type AgentSessionMessageRole =
  "user" | "assistant" | "tool" | "thinking" | "system" | "error";

export interface AgentSessionMessage {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly images: readonly AgentImage[];
  readonly role: AgentSessionMessageRole;
  readonly toolCallId: string | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly toolName: string | null;
}

export interface AgentSessionSummary {
  readonly activeDurationMs: number;
  readonly activeStartedAt: number | null;
  readonly autoCompact: boolean;
  readonly costBasis: AgentSessionCostBasis;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly credentialId: string;
  readonly currentContextTokens: number;
  readonly id: string;
  readonly maxContextTokens: number | null;
  readonly model: string;
  readonly provider: ProviderId;
  readonly providerPricing: ProviderModelPricing | null;
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly runnerId: string;
  readonly pendingQuestions: PendingAskQuestions | null;
  readonly status: AgentSessionStatus;
  readonly title: string;
  readonly tools: readonly AgentSessionToolName[];
  readonly updatedAt: number;
  readonly workingDirectory: string;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  readonly agentFile: AgentFile | null;
  readonly messages: readonly AgentSessionMessage[];
}
