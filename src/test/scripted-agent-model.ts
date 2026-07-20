import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../agent-loop.ts";

export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #turns: AgentModelTurn[];

  constructor(turns: AgentModelTurn[]) {
    this.#turns = turns;
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
