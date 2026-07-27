import { expect } from "vitest";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";

export function providerTurn(
  content: string,
  overrides: Partial<AgentModelTurn> = {},
): AgentModelTurn {
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

const DONE_TURN = providerTurn("Done.");

export function expectDoneTurn(turn: AgentModelTurn): void {
  expect(turn).toEqual(DONE_TURN);
}
