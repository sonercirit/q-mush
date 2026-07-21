import type { AgentSessionDetail } from "../session-model.ts";

export const TEST_SESSION_DETAIL: AgentSessionDetail = {
  agentFile: null,
  autoCompact: true,
  createdAt: 1,
  credentialId: "credential-1",
  currentContextTokens: 1_250,
  id: "session-1",
  maxContextTokens: 200_000,
  messages: [],
  model: "gpt-5-codex",
  provider: "openai",
  reasoningEffort: null,
  runnerId: "runner-1",
  status: "idle",
  title: "Fix the app",
  updatedAt: 2,
  workingDirectory: ".",
};
