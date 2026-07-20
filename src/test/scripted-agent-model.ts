import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../agent-loop.ts";

type ScriptedTurn = Omit<AgentModelTurn, "contextTokens" | "thinking"> & {
  readonly contextTokens?: number | null;
  readonly thinking?: string;
};

export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #turns: AgentModelTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.#turns = turns.map((turn) => ({
      ...turn,
      contextTokens:
        turn.contextTokens === undefined ? null : turn.contextTokens,
      thinking: turn.thinking ?? "",
    }));
  }

  complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelTurn> {
    this.requests.push([...messages]);
    const turn = this.#turns.shift();

    if (turn === undefined) {
      throw new Error("The scripted model ran out of turns");
    }

    return Promise.resolve(turn);
  }
}
