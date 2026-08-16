import {
  AGENT_REASONING_EFFORTS,
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import { utf8Prefix } from "../shared/utf8.ts";
import { isNullOrPositiveSafeInteger } from "../shared/validation.ts";

const MAXIMUM_MODEL_LABEL_BYTES = 300;
const MAXIMUM_MODEL_FALLBACK_PROMPT_BYTES = 4_000;
const MAXIMUM_MODEL_METADATA_ITEMS = 20;
const MAXIMUM_MODEL_METADATA_INPUT_ITEMS = 100;
const MAXIMUM_MODEL_METADATA_TEXT_BYTES = 100;

function boundedArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, MAXIMUM_MODEL_METADATA_INPUT_ITEMS)
    : undefined;
}

export function reasoningEfforts(
  value: unknown,
): readonly AgentReasoningEffort[] {
  const candidates = boundedArray(value);
  if (candidates === undefined) return [];
  const efforts: AgentReasoningEffort[] = [];
  for (const item of candidates) {
    const effort = isRecord(item) ? item["effort"] : item;
    if (isAgentReasoningEffort(effort) && !efforts.includes(effort)) {
      efforts.push(effort);
      if (efforts.length === AGENT_REASONING_EFFORTS.length) break;
    }
  }
  return efforts;
}

function uniqueStrings(value: unknown): readonly string[] | null {
  const candidates = boundedArray(value);
  if (candidates === undefined) return null;
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (selected.length >= MAXIMUM_MODEL_METADATA_ITEMS) break;
    if (typeof item !== "string" || item.length === 0) continue;
    const bounded = utf8Prefix(item, MAXIMUM_MODEL_METADATA_TEXT_BYTES);
    if (bounded.length > 0 && !seen.has(bounded)) {
      seen.add(bounded);
      selected.push(bounded);
    }
  }
  return selected;
}

function directOrNestedValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  parentKey: string,
): unknown {
  if (key in value) return value[key];
  const parent = value[parentKey];
  if (!isRecord(parent)) return undefined;
  return parent[key];
}

function modelTokenLimit(
  value: Readonly<Record<string, unknown>>,
  candidateKeys: readonly string[],
): number | null {
  for (const candidateKey of candidateKeys) {
    const candidate = directOrNestedValue(value, candidateKey, "capabilities");
    if (!isNullOrPositiveSafeInteger(candidate)) continue;
    if (candidate !== null) return candidate;
  }
  return null;
}

function modelPricing(value: unknown): ProviderModelPricing | null {
  if (!isRecord(value)) return null;
  const pricing: Partial<
    Record<
      "cacheWriteInput" | "cachedInput" | "input" | "output",
      string | number
    >
  > = {};
  const add = (
    target: "cacheWriteInput" | "cachedInput" | "input" | "output",
    keys: readonly string[],
  ): void => {
    for (const key of keys) {
      const price = value[key];
      const bounded =
        typeof price === "string"
          ? utf8Prefix(price.trim(), MAXIMUM_MODEL_METADATA_TEXT_BYTES)
          : price;
      if (
        (typeof bounded === "string" && bounded.length > 0) ||
        (typeof bounded === "number" &&
          Number.isFinite(bounded) &&
          bounded >= 0)
      ) {
        pricing[target] = bounded;
        return;
      }
    }
  };
  add("cacheWriteInput", ["cache_write_input", "input_cache_write"]);
  add("cachedInput", ["cached_input", "input_cache_read"]);
  add("input", ["prompt", "input"]);
  add("output", ["completion", "output"]);
  return Object.keys(pricing).length === 0 ? null : pricing;
}

export function modelOption(
  value: unknown,
  idKey: string,
  labelKey: string,
  efforts: readonly AgentReasoningEffort[],
  contextKeys: readonly string[],
  outputTokenKeys: readonly string[] = [],
): AgentModelOption | undefined {
  if (!isRecord(value)) return undefined;
  const id = value[idKey];
  if (!isAgentModelId(id)) return undefined;
  const label = value[labelKey];
  return {
    adaptiveThinking: null,
    contextWindow: modelTokenLimit(value, contextKeys),
    maxOutputTokens: modelTokenLimit(value, outputTokenKeys),
    ...(typeof value["fallback_prompt"] === "string"
      ? {
          fallbackPrompt:
            utf8Prefix(
              value["fallback_prompt"].trim(),
              MAXIMUM_MODEL_FALLBACK_PROMPT_BYTES,
            ) || null,
        }
      : {}),
    id,
    inputModalities: uniqueStrings(
      directOrNestedValue(value, "input_modalities", "architecture"),
    ),
    label:
      typeof label === "string" && label.trim().length > 0
        ? utf8Prefix(label.trim(), MAXIMUM_MODEL_LABEL_BYTES)
        : id,
    outputModalities: uniqueStrings(
      directOrNestedValue(value, "output_modalities", "architecture"),
    ),
    pricing: modelPricing(value["pricing"]),
    reasoningEfforts: efforts,
  };
}
