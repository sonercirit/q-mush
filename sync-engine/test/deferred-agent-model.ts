import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { recordAgentModelRequest } from "./scripted-agent-model.ts";
import { connectedSessionSetup } from "./session-integration-fixtures.ts";

export function terminalAgentStep(content: string): AgentModelStep {
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
  readonly #result = Promise.withResolvers<AgentModelStep>();

  resolve(step: AgentModelStep): void {
    this.#result.resolve(step);
  }

  readonly complete = (
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> => {
    recordAgentModelRequest(this.requests, messages);
    return this.#result.promise;
  };

  resolveContent(content: string): void {
    this.resolve(terminalAgentStep(content));
  }
}
