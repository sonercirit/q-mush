import { describe, expect, test } from "vitest";
import type { AgentTokenUsage } from "../../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { estimateAgentTurnCost } from "../../sync-engine/agent-cost.ts";

const SESSION: Pick<
  AgentSessionDetail,
  "model" | "provider" | "providerPricing"
> = {
  model: "gpt-4.1-mini",
  provider: "openai",
  providerPricing: null,
};
const USAGE: AgentTokenUsage = {
  cacheWriteInputTokens: 0,
  cachedInputTokens: 1_000,
  inputTokens: 2_000,
  outputTokens: 500,
};

function providerSession(
  providerPricing: AgentSessionDetail["providerPricing"],
): typeof SESSION {
  return { ...SESSION, provider: "openrouter", providerPricing };
}

describe("agent cost", () => {
  test("estimates OpenAI cost from detailed token usage", () => {
    expect(estimateAgentTurnCost(SESSION, USAGE)).toBeCloseTo(0.0013);
  });

  test("uses base rates for date-versioned OpenAI models", () => {
    expect(
      estimateAgentTurnCost(
        { ...SESSION, model: "gpt-4.1-mini-2025-04-14" },
        USAGE,
      ),
    ).toBeCloseTo(0.0013);
  });

  test("uses provider prices expressed per token", () => {
    expect(
      estimateAgentTurnCost(
        providerSession({
          cachedInput: "0.0000001",
          input: "0.0000004",
          output: "0.0000016",
        }),
        USAGE,
      ),
    ).toBeCloseTo(0.0013);
  });

  test("does not bill cache-write tokens twice as regular input", () => {
    expect(
      estimateAgentTurnCost(
        providerSession({
          cacheWriteInput: 0.0000005,
          input: 0.0000004,
          output: 0,
        }),
        {
          ...USAGE,
          cacheWriteInputTokens: 500,
          cachedInputTokens: 0,
          outputTokens: 0,
        },
      ),
    ).toBeCloseTo(0.00085);
  });

  test("returns no estimate without complete pricing or usage", () => {
    expect(
      estimateAgentTurnCost({ ...SESSION, model: "unknown-model" }, USAGE),
    ).toBeNull();
    expect(estimateAgentTurnCost(SESSION, null)).toBeNull();
  });
});
