import type { ProviderModelPricing } from "./provider-model-pricing.ts";

// `ultra` is Codex client orchestration, not a provider reasoning value.
export const AGENT_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelOption {
  readonly adaptiveThinking: boolean | null;
  readonly contextWindow: number | null;
  readonly fallbackPrompt?: string | null;
  readonly id: string;
  readonly inputModalities: readonly string[] | null;
  readonly label: string;
  readonly maxOutputTokens: number | null;
  readonly outputModalities: readonly string[] | null;
  readonly pricing: ProviderModelPricing | null;
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
}

export interface AgentModelCatalog {
  readonly defaultModel: string | null;
  readonly models: readonly AgentModelOption[];
}

const OPENROUTER_PROVIDER_ROUTING_PREFIX = "q-mush-routing:";
export const OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE = `${OPENROUTER_PROVIDER_ROUTING_PREFIX}no-fallbacks`;
const OPENROUTER_PROVIDER_ORDER_PREFIX = `${OPENROUTER_PROVIDER_ROUTING_PREFIX}order:`;
export const OPENROUTER_PROVIDER_SORTS = [
  "price",
  "throughput",
  "latency",
  "exacto",
] as const;

export type OpenRouterProviderSort = (typeof OPENROUTER_PROVIDER_SORTS)[number];

export type OpenRouterProviderRouting =
  | { readonly type: "automatic" }
  | { readonly type: "no_fallbacks" }
  | { readonly tag: string; readonly type: "order" }
  | { readonly sort: OpenRouterProviderSort; readonly type: "sort" }
  | { readonly tag: string; readonly type: "provider" };

export interface OpenRouterProviderOption {
  readonly contextWindow: number | null;
  readonly name: string;
  readonly pricing: ProviderModelPricing | null;
  readonly tag: string;
}

export interface OpenRouterProviderCatalog {
  readonly providers: readonly OpenRouterProviderOption[];
}

export const MAXIMUM_AGENT_MODEL_OPTIONS = 10_000;

const MODEL_PATTERN = /^[A-Za-z\d][A-Za-z\d._:/-]{0,199}$/u;
const OPENROUTER_PROVIDER_TAG_PATTERN = /^[A-Za-z\d][A-Za-z\d._:/-]{0,99}$/u;

export function isAgentModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_PATTERN.test(value);
}

export function openRouterProviderOrderValue(tag: string): string {
  return `${OPENROUTER_PROVIDER_ORDER_PREFIX}${tag}`;
}

export function openRouterProviderSortValue(
  sort: OpenRouterProviderSort,
): string {
  return `${OPENROUTER_PROVIDER_ROUTING_PREFIX}${sort}`;
}

export function readOpenRouterProviderRouting(
  value: string | null | undefined,
): OpenRouterProviderRouting | undefined {
  if (value === null || value === undefined || value.length === 0) {
    return { type: "automatic" };
  }
  if (value === OPENROUTER_PROVIDER_NO_FALLBACKS_VALUE) {
    return { type: "no_fallbacks" };
  }
  if (value.startsWith(OPENROUTER_PROVIDER_ORDER_PREFIX)) {
    const tag = value.slice(OPENROUTER_PROVIDER_ORDER_PREFIX.length);
    return isOpenRouterProviderTag(tag) ? { tag, type: "order" } : undefined;
  }
  if (value.startsWith(OPENROUTER_PROVIDER_ROUTING_PREFIX)) {
    const sort = value.slice(OPENROUTER_PROVIDER_ROUTING_PREFIX.length);
    return isOpenRouterProviderSort(sort) ? { sort, type: "sort" } : undefined;
  }
  return isOpenRouterProviderTag(value)
    ? { tag: value, type: "provider" }
    : undefined;
}

function isOpenRouterProviderSort(
  value: unknown,
): value is OpenRouterProviderSort {
  return OPENROUTER_PROVIDER_SORTS.some((sort) => sort === value);
}

export function isOpenRouterProviderSelection(value: unknown): value is string {
  return (
    typeof value === "string" &&
    readOpenRouterProviderRouting(value) !== undefined
  );
}

export function readOpenRouterProviderTag(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  return isOpenRouterProviderSelection(value) ? value : undefined;
}

export function isOpenRouterProviderTag(value: unknown): value is string {
  return (
    typeof value === "string" && OPENROUTER_PROVIDER_TAG_PATTERN.test(value)
  );
}

export function isAgentReasoningEffort(
  value: unknown,
): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.some((effort) => effort === value);
}

export function maximumAgentReasoningEffort(
  efforts: readonly AgentReasoningEffort[],
): AgentReasoningEffort | undefined {
  for (let index = AGENT_REASONING_EFFORTS.length - 1; index >= 0; index -= 1) {
    const effort = AGENT_REASONING_EFFORTS[index];

    if (effort !== undefined && efforts.includes(effort)) {
      return effort;
    }
  }

  return undefined;
}

export function reasoningEffortLabel(effort: AgentReasoningEffort): string {
  switch (effort) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
  }
}
