import { describe, expect, test } from "vitest";
import type { AgentTokenUsage } from "../../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { estimateAgentStepCost } from "../../sync-engine/agent-cost.ts";

const SESSION: Pick<AgentSessionDetail, "providerPricing"> = {
  providerPricing: null,
};
const USAGE: AgentTokenUsage = {
  cacheWriteInputTokens: 0,
  cachedInputTokens: 1_000,
  inputTokens: 2_000,
  outputTokens: 500,
};
const CACHE_WRITE_USAGE: AgentTokenUsage = {
  ...USAGE,
  cacheWriteInputTokens: 500,
  cachedInputTokens: 0,
  outputTokens: 0,
};

function providerSession(
  providerPricing: AgentSessionDetail["providerPricing"],
): typeof SESSION {
  return { providerPricing };
}

describe("agent cost", () => {
  test("does not use built-in pricing", () => {
    expect(estimateAgentStepCost(SESSION, USAGE)).toBeNull();
  });

  test("uses provider prices expressed per token", () => {
    expect(
      estimateAgentStepCost(
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
      estimateAgentStepCost(
        providerSession({
          cacheWriteInput: 0.0000005,
          input: 0.0000004,
          output: 0,
        }),
        CACHE_WRITE_USAGE,
      ),
    ).toBeCloseTo(0.00085);
  });

  test("does not invent missing cache prices", () => {
    expect(
      estimateAgentStepCost(
        providerSession({ input: 0.0000004, output: 0.0000016 }),
        USAGE,
      ),
    ).toBeNull();
    expect(
      estimateAgentStepCost(
        providerSession({ input: 0.0000004, output: 0 }),
        CACHE_WRITE_USAGE,
      ),
    ).toBeNull();
  });

  test("returns no estimate without pricing or usage", () => {
    expect(estimateAgentStepCost(SESSION, null)).toBeNull();
  });
});
