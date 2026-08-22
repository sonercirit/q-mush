import type { AgentProviderReplay } from "../../shared/agent-loop.ts";

export function privateReplay(
  signature: string,
  text: string,
): AgentProviderReplay {
  return {
    blocks: [
      { signature, thinking: "", type: "thinking" },
      { text, type: "text" },
    ],
    model: "fork-model",
    protocol: "anthropic",
    provenance: "test-provenance",
  };
}
