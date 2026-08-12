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

function anthropicCapabilityEfforts(
  capabilities: unknown,
): readonly AgentReasoningEffort[] {
  const effort = capabilityRecord(capabilities, "effort");
  if (effort?.["supported"] !== true) {
    return [];
  }
  const efforts = AGENT_REASONING_EFFORTS.filter((level) =>
    capabilitySupported(effort, level),
  );
  // Omitting both effort and thinking parameters is always valid.
  return efforts.length === 0 ? [] : ["none", ...efforts];
}

function anthropicCapabilityModalities(
  capabilities: unknown,
): readonly string[] | null {
  if (!isRecord(capabilities)) {
    return null;
  }
  return [
    "text",
    ...(capabilitySupported(capabilities, "image_input") ? ["image"] : []),
    ...(capabilitySupported(capabilities, "pdf_input") ? ["pdf"] : []),
  ];
}

export function withAnthropicCapabilities(
  option: AgentModelOption,
  entry: Readonly<Record<string, unknown>>,
): AgentModelOption {
  const capabilities = entry["capabilities"];
  const efforts = anthropicCapabilityEfforts(capabilities);
  const modalities = anthropicCapabilityModalities(capabilities);
  return {
    ...option,
    ...(modalities === null ? {} : { inputModalities: modalities }),
    ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
  };
}
