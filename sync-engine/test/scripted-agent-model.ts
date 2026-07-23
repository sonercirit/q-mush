import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../../shared/agent-loop.ts";

type ScriptedTurn = Omit<
  AgentModelTurn,
  "contextTokens" | "costUsd" | "thinking" | "tokenUsage"
> & {
  readonly contextTokens?: number | null;
  readonly costUsd?: number | null;
  readonly thinking?: string;
  readonly tokenUsage?: AgentModelTurn["tokenUsage"];
};

export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #turns: AgentModelTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.#turns = turns.map((turn) => ({
      ...turn,
      contextTokens:
        turn.contextTokens === undefined ? null : turn.contextTokens,
      costUsd: turn.costUsd ?? null,
      thinking: turn.thinking ?? "",
      tokenUsage: turn.tokenUsage ?? null,
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
