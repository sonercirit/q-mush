import { expect } from "vitest";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";

const DONE_TURN: AgentModelTurn = {
  content: "Done.",
  contextTokens: null,
  costUsd: null,
  thinking: "",
  tokenUsage: null,
  toolCalls: [],
};

export function expectDoneTurn(turn: AgentModelTurn): void {
  expect(turn).toEqual(DONE_TURN);
}
