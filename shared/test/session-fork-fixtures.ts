import type { SessionForkSelection } from "../session-fork.ts";

export const TEST_SESSION_FORK_SELECTION = {
  credentialId: "credential-2",
  model: "openai/gpt-5",
  provider: "openrouter",
  reasoningEffort: "high",
} as const satisfies SessionForkSelection;
