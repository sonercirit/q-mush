import {
  normalizeAgentToolCall,
  type AgentModelStep,
  type AgentTokenUsage,
  type AgentToolCall,
} from "../shared/agent-loop.ts";
import type { ProviderToolCallDelta } from "../shared/tool-stream.ts";
import { readNonNegativeSafeInteger } from "../shared/validation.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export interface PartialProviderToolCall {
  arguments: string;
  id: string;
  name: string;
}

export function sortedToolCalls(
  toolCalls: ReadonlyMap<number, AgentToolCall | PartialProviderToolCall>,
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

export function emitToolCallDelta(
  onDelta: ((delta: ProviderTextDelta) => void) | undefined,
  toolCall: ProviderToolCallDelta,
): void {
  onDelta?.({ content: "", thinking: "", toolCall });
}

export function providerEventIndex(
  event: Readonly<Record<string, unknown>>,
  key: string,
  kind: string,
): number {
  const index = readNonNegativeSafeInteger(event[key]);

  if (index === undefined) {
    throw new Error(`The provider returned an invalid ${kind}`);
  }

  return index;
}

export function providerStep(
  content: string,
  contextTokens: number | null,
  thinking: string,
  toolCalls: readonly AgentToolCall[],
  costUsd: number | null = null,
  tokenUsage: AgentTokenUsage | null = null,
): AgentModelStep {
  return { content, contextTokens, costUsd, thinking, tokenUsage, toolCalls };
}
