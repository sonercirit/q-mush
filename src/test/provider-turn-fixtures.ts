import { expect } from "bun:test";
import type { AgentModelTurn } from "../agent-loop.ts";

const DONE_TURN: AgentModelTurn = {
  content: "Done.",
  contextTokens: null,
  thinking: "",
  toolCalls: [],
};

export function expectDoneTurn(turn: AgentModelTurn): void {
  expect(turn).toEqual(DONE_TURN);
}
