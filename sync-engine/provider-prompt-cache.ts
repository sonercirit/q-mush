import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AnthropicReplayBlock } from "../shared/anthropic-replay.ts";
import { isRecord } from "../shared/auth-model.ts";

// Anthropic-compatible endpoints accept at most four cache breakpoints per
// request. Q Mush spends one on the static tools/system prefix and two rolling
// ones near the transcript tail, so each step reads the previous step's cache
// entry even when a step appends more blocks than the provider's automatic
// prefix lookback covers.
const ROLLING_BREAKPOINT_GAP = 2;

// The one-hour TTL costs more per cache write but keeps a session's prefix
// warm across think time, tool runs, and user pauses that outlive the default
// five-minute cache.
const PROMPT_CACHE_CONTROL: Readonly<Record<string, string>> = {
  ttl: "1h",
  type: "ephemeral",
};

function cacheableMessage(
  message: AgentConversationMessage | undefined,
): boolean {
  return (
    message !== undefined &&
    message.role !== "compaction_notice" &&
    message.content.length > 0
  );
}

function cacheableIndexAtOrBefore(
  messages: readonly AgentConversationMessage[],
  start: number,
): number | undefined {
  let index = Math.min(start, messages.length - 1);
  while (index >= 0) {
    if (cacheableMessage(messages[index])) {
      return index;
    }
    index -= 1;
  }

  return undefined;
}

export function promptCacheBreakpoints(
  messages: readonly AgentConversationMessage[],
): ReadonlySet<number> {
  const breakpoints = new Set<number>();
  const last = cacheableIndexAtOrBefore(messages, messages.length - 1);

  if (last === undefined) {
    return breakpoints;
  }

  breakpoints.add(last);
  const previous = cacheableIndexAtOrBefore(
    messages,
    last - ROLLING_BREAKPOINT_GAP,
  );

  if (previous !== undefined) {
    breakpoints.add(previous);
  }

  return breakpoints;
}

// The Messages cache_control surface documents text and tool_use placements.
// Other replay types stay byte-for-byte provider output while the scan moves
// backward to the nearest documented block.
function acceptsReplayCacheControl(block: AnthropicReplayBlock): boolean {
  return block.type === "text" || block.type === "tool_use";
}

export function withAnthropicReplayCacheControl(
  parts: readonly AnthropicReplayBlock[],
): readonly unknown[] | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && acceptsReplayCacheControl(part)) {
      return parts.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? { ...candidate, cache_control: PROMPT_CACHE_CONTROL }
          : candidate,
      );
    }
  }
  return undefined;
}

export function withPromptCacheControl(
  parts: readonly unknown[],
): readonly unknown[] {
  const last = parts.length - 1;
  return parts.map((part, index) =>
    index === last && isRecord(part)
      ? { ...part, cache_control: PROMPT_CACHE_CONTROL }
      : part,
  );
}
