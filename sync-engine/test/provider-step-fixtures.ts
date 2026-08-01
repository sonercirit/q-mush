import { expect } from "vitest";
import type { AgentModelStep } from "../../shared/agent-loop.ts";

export function providerStep(
  content: string,
  overrides: Partial<AgentModelStep> = {},
): AgentModelStep {
  return {
    content,
    contextTokens: null,
    costUsd: null,
    thinking: "",
    tokenUsage: null,
    toolCalls: [],
    ...overrides,
  };
}

const DONE_STEP = providerStep("Done.");

export function expectDoneStep(step: AgentModelStep): void {
  expect(step).toEqual(DONE_STEP);
}
