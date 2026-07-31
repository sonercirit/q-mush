import type { AgentTokenUsage } from "../shared/agent-loop.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

interface TokenRates {
  readonly cacheWriteInput: number | undefined;
  readonly cachedInput: number | undefined;
  readonly input: number | undefined;
  readonly output: number | undefined;
}

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
  const rates: TokenRates = {
    cacheWriteInput: finitePrice(pricing.cacheWriteInput),
    cachedInput: finitePrice(pricing.cachedInput),
    input: finitePrice(pricing.input),
    output: finitePrice(pricing.output),
  };
  return Object.values(rates).some((rate) => rate !== undefined) ? rates : null;
}

function tokenCost(tokens: number, rate: number | undefined): number | null {
  return tokens === 0 ? 0 : rate === undefined ? null : tokens * rate;
}

function estimatedCost(
  usage: AgentTokenUsage,
  rates: TokenRates,
): number | null {
  const cachedInput = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInput = usage.inputTokens - cachedInput;
  const cacheWriteInput = Math.min(usage.cacheWriteInputTokens, uncachedInput);
  const costs = [
    tokenCost(uncachedInput - cacheWriteInput, rates.input),
    tokenCost(cachedInput, rates.cachedInput),
    tokenCost(cacheWriteInput, rates.cacheWriteInput),
    tokenCost(usage.outputTokens, rates.output),
  ];
  if (!costs.every((cost): cost is number => cost !== null)) {
    return null;
  }
  return costs.reduce((total, cost) => total + cost, 0);
}

export function estimateAgentTurnCost(
  session: Pick<AgentSessionDetail, "providerPricing">,
  usage: AgentTokenUsage | null,
): number | null {
  if (usage === null) {
    return null;
  }
  const rates = providerRates(session.providerPricing);
  return rates === null ? null : estimatedCost(usage, rates);
}
