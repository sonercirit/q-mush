import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../../shared/agent-loop.ts";

// cpd-ignore-start -- A controllable model necessarily mirrors the production model interface and turn defaults.
export class ControlledModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #completions: ((turn: AgentModelTurn) => void)[] = [];

  complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelTurn> {
    this.requests.push([...messages]);
    return new Promise((resolve) => {
      this.#completions.push(resolve);
    });
  }

  resolve(
    turn: Partial<AgentModelTurn> & Pick<AgentModelTurn, "content">,
  ): void {
    const complete = this.#completions.shift();
    if (complete === undefined) {
      throw new Error("No model request is waiting");
    }
    complete({
      contextTokens: null,
      costUsd: null,
      thinking: "",
      tokenUsage: null,
      toolCalls: [],
      ...turn,
    });
  }
}
// cpd-ignore-end
