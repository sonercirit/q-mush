import type { AgentTokenUsage } from "../shared/agent-loop.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

interface TokenRates {
  readonly cacheWriteInput: number;
  readonly cachedInput: number;
  readonly input: number;
  readonly output: number;
}

type PublishedRates = Omit<TokenRates, "cacheWriteInput"> & {
  readonly cacheWriteInput?: number;
};

const OPENAI_PRICES_PER_MILLION: Readonly<Record<string, PublishedRates>> = {
  "gpt-4.1": { cachedInput: 0.5, input: 2, output: 8 },
  "gpt-4.1-mini": { cachedInput: 0.1, input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { cachedInput: 0.025, input: 0.1, output: 0.4 },
  "gpt-5-codex": { cachedInput: 0.125, input: 1.25, output: 10 },
  "gpt-5.4": { cachedInput: 0.25, input: 2.5, output: 15 },
  "gpt-5.4-mini": { cachedInput: 0.075, input: 0.75, output: 4.5 },
  "gpt-5.5": { cachedInput: 0.5, input: 5, output: 30 },
  "gpt-5.6-luna": {
    cacheWriteInput: 1.25,
    cachedInput: 0.1,
    input: 1,
    output: 6,
  },
  "gpt-5.6-sol": {
    cacheWriteInput: 6.25,
    cachedInput: 0.5,
    input: 5,
    output: 30,
  },
  "gpt-5.6-terra": {
    cacheWriteInput: 3.125,
    cachedInput: 0.25,
    input: 2.5,
    output: 15,
  },
};

function finitePrice(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const price = typeof value === "number" ? value : Number(value);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function providerRates(
  pricing: ProviderModelPricing | null,
): TokenRates | null {
  if (pricing === null) {
    return null;
  }
  const input = finitePrice(pricing.input);
  const output = finitePrice(pricing.output);
  if (input === undefined || output === undefined) {
    return null;
  }
  return {
    cacheWriteInput: finitePrice(pricing.cacheWriteInput) ?? input,
    cachedInput: finitePrice(pricing.cachedInput) ?? input,
    input,
    output,
  };
}

function openAiRates(model: string): TokenRates | null {
  const baseModel = model.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  const published = OPENAI_PRICES_PER_MILLION[baseModel];
  if (published === undefined) {
    return null;
  }
  return {
    cacheWriteInput: published.cacheWriteInput ?? published.input,
    cachedInput: published.cachedInput,
    input: published.input,
    output: published.output,
  };
}

function estimatedCost(usage: AgentTokenUsage, rates: TokenRates): number {
  const cachedInput = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInput = usage.inputTokens - cachedInput;
  const cacheWriteInput = Math.min(usage.cacheWriteInputTokens, uncachedInput);
  const regularInput = uncachedInput - cacheWriteInput;
  return (
    regularInput * rates.input +
    cachedInput * rates.cachedInput +
    cacheWriteInput * rates.cacheWriteInput +
    usage.outputTokens * rates.output
  );
}

export function estimateAgentTurnCost(
  session: Pick<AgentSessionDetail, "model" | "provider" | "providerPricing">,
  usage: AgentTokenUsage | null,
): number | null {
  if (usage === null) {
    return null;
  }
  const provider = providerRates(session.providerPricing);
  if (provider !== null) {
    return estimatedCost(usage, provider);
  }
  const openAi =
    session.provider === "openai" ? openAiRates(session.model) : null;
  return openAi === null ? null : estimatedCost(usage, openAi) / 1_000_000;
}
