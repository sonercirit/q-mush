import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type { AgentFile } from "./agent-file.ts";
import type { AgentToolCall } from "./agent-loop.ts";
import type { ProviderId } from "./provider-credential-store.ts";

export type AgentSessionStatus =
  "queued" | "running" | "idle" | "stopped" | "failed";

type AgentSessionMessageRole =
  "user" | "assistant" | "tool" | "thinking" | "system";

export interface AgentSessionMessage {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly role: AgentSessionMessageRole;
  readonly toolCallId: string | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly toolName: string | null;
}

export interface AgentSessionSummary {
  readonly autoCompact: boolean;
  readonly createdAt: number;
  readonly credentialId: string;
  readonly currentContextTokens: number;
  readonly id: string;
  readonly maxContextTokens: number | null;
  readonly model: string;
  readonly provider: ProviderId;
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly runnerId: string;
  readonly status: AgentSessionStatus;
  readonly title: string;
  readonly updatedAt: number;
  readonly workingDirectory: string;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  readonly agentFile: AgentFile | null;
  readonly messages: readonly AgentSessionMessage[];
}
