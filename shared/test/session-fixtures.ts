import { AGENT_SESSION_TOOL_NAMES } from "../agent-tools.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../session-model.ts";

export function startedAtUtc(): number {
  return Date.UTC(2026, 6, 27, 12, 0, 0);
}

export function testSessionMessage(
  id: string,
  content: string,
  role: AgentSessionMessage["role"],
  createdAt: number,
): AgentSessionMessage {
  return {
    content,
    createdAt,
    id,
    images: [],
    role,
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
}

export const TEST_SESSION_DETAIL: AgentSessionDetail = {
  activeDurationMs: 0,
  activeStartedAt: null,
  stepStartedAt: null,
  adaptiveThinking: null,
  agentFile: null,
  agentFilePath: null,
  autoCompact: true,
  idleCompact: false,
  costBasis: "none",
  costUsd: 0,
  createdAt: 1,
  credentialId: "credential-1",
  generation: 0,
  hasOlderSegments: false,
  currentContextTokens: 1_250,
  executionEnvironment: "bare_metal",
  id: "session-1",
  maxContextTokens: 200_000,
  maxOutputTokens: null,
  userContextTokenCap: null,
  messages: [],
  model: "gpt-5-codex",
  modelContextTokens: 200_000,
  openRouterProviderTag: null,
  parentExecutionGeneration: null,
  parentSessionId: null,
  pendingInputs: [],
  pendingQuestions: null,
  provider: "openai",
  providerPricing: null,
  reasoningEffort: null,
  restartHandoff: null,
  runnerId: "runner-1",
  runnerRequired: false,
  status: "idle",
  title: "Fix the app",
  tools: AGENT_SESSION_TOOL_NAMES,
  updatedAt: 2,
  workingDirectory: ".",
  workspaceId: "workspace-1",
};
