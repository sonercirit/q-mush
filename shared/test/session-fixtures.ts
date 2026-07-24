import { AGENT_SESSION_TOOL_NAMES } from "../agent-tools.ts";
import type { AgentSessionDetail } from "../session-model.ts";

export function createTestSessionDetail(): AgentSessionDetail {
  return {
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
    model: "gpt-5-codex",
    openRouterProviderTag: null,
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
}
