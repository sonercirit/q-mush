import {
  normalizeAgentToolCall,
  type AgentModelTurn,
  type AgentTokenUsage,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export function sortedToolCalls(
  toolCalls: ReadonlyMap<
    number,
    AgentToolCall | { arguments: string; id: string; name: string }
  >,
): readonly AgentToolCall[] {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => normalizeAgentToolCall(call))
    .filter((call) => call !== undefined);
}

export function emitProviderDelta(
  onDelta: ((delta: ProviderTextDelta) => void) | undefined,
  content: string,
  thinking: string,
): void {
  if (content.length > 0 || thinking.length > 0) {
    onDelta?.({ content, thinking });
  }
}

export function providerTurn(
  content: string,
  contextTokens: number | null,
  thinking: string,
  toolCalls: readonly AgentToolCall[],
  costUsd: number | null = null,
  tokenUsage: AgentTokenUsage | null = null,
): AgentModelTurn {
  return { content, contextTokens, costUsd, thinking, tokenUsage, toolCalls };
}
