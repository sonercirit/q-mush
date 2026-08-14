import type { AnthropicReplayIdentity } from "../../sync-engine/anthropic-replay-identity.ts";

export const TEST_REPLAY_IDENTITY: AnthropicReplayIdentity = {
  model: "gpt-4.1-mini",
  provenance: "test-provenance",
};

export function replayIdentity(
  model: string,
  provenance = TEST_REPLAY_IDENTITY.provenance,
): AnthropicReplayIdentity {
  return { model, provenance };
}
