import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";

export const TEST_SESSION_DETAIL: AgentSessionDetail = {
  activeDurationMs: 0,
  activeStartedAt: null,
  agentFile: null,
  autoCompact: true,
  costBasis: "none",
  costUsd: 0,
  createdAt: 1,
  credentialId: "credential-1",
  currentContextTokens: 1_250,
  id: "session-1",
  maxContextTokens: 200_000,
  messages: [],
  pendingInputs: [],
  model: "gpt-5-codex",
  provider: "openai",
  providerPricing: null,
  reasoningEffort: null,
  runnerId: "runner-1",
  status: "idle",
  title: "Fix the app",
  tools: AGENT_SESSION_TOOL_NAMES,
  updatedAt: 2,
  workingDirectory: ".",
};
