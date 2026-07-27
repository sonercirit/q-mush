import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "../../shared/agent-loop.ts";
import { recordAgentModelRequest } from "./scripted-agent-model.ts";
import { connectedSessionSetup } from "./session-integration-fixtures.ts";

export function terminalAgentTurn(content: string): AgentModelTurn {
  return {
    content,
    contextTokens: 1_000,
    costUsd: null,
    thinking: "",
    tokenUsage: null,
    toolCalls: [],
  };
}

export function deferredSessionSetup(): Readonly<{
  model: DeferredAgentModel;
  setup: ReturnType<typeof connectedSessionSetup>;
}> {
  const model = new DeferredAgentModel();
  return { model, setup: connectedSessionSetup(model) };
}

export class DeferredAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #result = Promise.withResolvers<AgentModelTurn>();

  resolve(turn: AgentModelTurn): void {
    this.#result.resolve(turn);
  }

  readonly complete = (
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelTurn> => {
    recordAgentModelRequest(this.requests, messages);
    return this.#result.promise;
  };

  resolveContent(content: string): void {
    this.resolve(terminalAgentTurn(content));
  }
}
