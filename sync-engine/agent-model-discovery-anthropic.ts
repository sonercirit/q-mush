import {
  AGENT_REASONING_EFFORTS,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";

// The Anthropic Models API publishes a capability tree with `supported`
// booleans at each leaf: `capabilities.effort.<level>.supported`,
// `capabilities.thinking.types.adaptive.supported`, and
// `capabilities.image_input`/`pdf_input`. Anthropic-compatible proxies may
// omit it; absent capabilities leave the option unchanged.
function capabilityRecord(
  value: unknown,
  ...path: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function capabilitySupported(
  value: unknown,
  ...path: readonly string[]
): boolean {
  return capabilityRecord(value, ...path)?.["supported"] === true;
}

// Undefined means efforts are unknown (fallback-eligible), while an array —
// possibly empty — is authoritative: explicit denials and unverifiable
// adaptive support must not be overwritten by the OpenAI-style fallback
// listing. Efforts are offered only alongside adaptive thinking because
// selecting one turns on `thinking: {type: "adaptive"}`, which
// adaptive-incapable models reject — including effort-capable
// extended-thinking-only models (Claude Opus 4.5), which stay effortless
// here until sessions carry per-model thinking capabilities.
function anthropicCapabilityEfforts(
  capabilities: unknown,
): readonly AgentReasoningEffort[] | undefined {
  const effort = capabilityRecord(capabilities, "effort");
  const thinking = capabilityRecord(capabilities, "thinking");
  const adaptive = capabilityRecord(thinking, "types")?.["adaptive"];
  const adaptiveSupported = isRecord(adaptive)
    ? adaptive["supported"] === true
    : adaptive === true;
  // An explicit denial — a thinking node whose own leaf withholds support,
  // or an adaptive leaf (record or boolean shorthand) that does — is
  // authoritative even without effort metadata; when every leaf is absent,
  // support is unknown.
  if (
    thinking?.["supported"] === false ||
    (adaptive !== undefined && !adaptiveSupported)
  ) {
    return [];
  }
  if (effort === undefined) {
    return undefined;
  }
  if (effort["supported"] !== true || !adaptiveSupported) {
    return [];
  }
  // The documented tree has no "none" leaf; skipping it defends against a
  // server publishing one, which would otherwise duplicate the prepended
  // level. Omitting both effort and thinking parameters is always valid.
  const efforts = AGENT_REASONING_EFFORTS.filter(
    (level) => level !== "none" && capabilitySupported(effort, level),
  );
  // Affirmed effort support without named levels reads as unknown, not
  // none: adaptive is confirmed, so listing-sourced levels are safe.
  return efforts.length === 0 ? undefined : ["none", ...efforts];
}

// Modalities are derived only when the tree actually describes them: proxies
// reuse `capabilities` for other metadata (context_window) while publishing
// top-level `input_modalities`, and an unconditional ["text"] would clobber
// that already-supported shape.
function anthropicCapabilityModalities(
  capabilities: unknown,
): readonly string[] | null {
  const image = capabilityRecord(capabilities, "image_input");
  const pdf = capabilityRecord(capabilities, "pdf_input");
  if (image === undefined && pdf === undefined) {
    return null;
  }
  return [
    "text",
    ...(image?.["supported"] === true ? ["image"] : []),
    ...(pdf?.["supported"] === true ? ["pdf"] : []),
  ];
}

export interface AnthropicCapabilityOption {
  readonly effortsAuthoritative: boolean;
  readonly option: AgentModelOption;
}

export function withAnthropicCapabilities(
  option: AgentModelOption,
  entry: Readonly<Record<string, unknown>>,
): AnthropicCapabilityOption {
  const capabilities = entry["capabilities"];
  const efforts = anthropicCapabilityEfforts(capabilities);
  const modalities = anthropicCapabilityModalities(capabilities);
  return {
    effortsAuthoritative: efforts !== undefined,
    option: {
      ...option,
      ...(modalities === null ? {} : { inputModalities: modalities }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    },
  };
}
