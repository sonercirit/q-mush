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

interface ScriptedModelOptions {
  readonly onComplete?: (requestCount: number) => Promise<void> | void;
}

export function recordAgentModelRequest<T>(
  requests: T[][],
  messages: readonly T[],
): AgentModelRequest<T> {
  const request = [...messages];
  requests.push(request);
  return { request, requestCount: requests.length };
}

interface AgentModelRequest<T> {
  readonly request: T[];
  readonly requestCount: number;
}

export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #onComplete:
    ((requestCount: number) => Promise<void> | void) | undefined;
  readonly #turns: AgentModelTurn[];

  constructor(turns: ScriptedTurn[], options: ScriptedModelOptions = {}) {
    this.#onComplete = options.onComplete;
    this.#turns = turns.map((turn) => ({
      ...turn,
      contextTokens:
        turn.contextTokens === undefined ? null : turn.contextTokens,
      costUsd: turn.costUsd ?? null,
      thinking: turn.thinking ?? "",
      tokenUsage: turn.tokenUsage ?? null,
    }));
  }

  async complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelTurn> {
    const { requestCount } = recordAgentModelRequest(this.requests, messages);
    await this.#onComplete?.(requestCount);
    const turn = this.#turns.shift();

    if (turn === undefined) {
      throw new Error("The scripted model ran out of turns");
    }

    return turn;
  }
}
