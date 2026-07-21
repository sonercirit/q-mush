import type { AgentModelTurn, AgentToolCall } from "./agent-loop.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export function sortedToolCalls(
  toolCalls: ReadonlyMap<
    number,
    AgentToolCall | { arguments: string; id: string; name: string }
  >,
): readonly AgentToolCall[] {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      arguments: call.arguments,
      id: call.id,
      name: call.name,
    }));
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
): AgentModelTurn {
  return { content, contextTokens, thinking, toolCalls };
}
