import { expect } from "vitest";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";

const DONE_TURN: AgentModelTurn = doneTurn("Done.");

export function doneTurn(content: string): AgentModelTurn {
  return {
    content,
    contextTokens: null,
    costUsd: null,
    thinking: "",
    tokenUsage: null,
    toolCalls: [],
  };
}

export function expectDoneTurn(turn: AgentModelTurn): void {
  expect(turn).toEqual(DONE_TURN);
}
