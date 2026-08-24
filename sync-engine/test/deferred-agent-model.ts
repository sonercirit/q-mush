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

export interface DeferredAgentModel extends AgentModel {
  readonly requests: AgentConversationMessage[][];
  readonly resolve: (step: AgentModelStep) => void;
  readonly resolveContent: (content: string) => void;
}

export function createDeferredAgentModel(): DeferredAgentModel {
  const requests: AgentConversationMessage[][] = [];
  const result = Promise.withResolvers<AgentModelStep>();
  const resolve = (step: AgentModelStep): void => {
    result.resolve(step);
  };
  return {
    requests,
    resolve,
    complete: (messages) => {
      recordAgentModelRequest(requests, messages);
      return result.promise;
    },
    resolveContent: (content) => {
      resolve(terminalAgentStep(content));
    },
  };
}

export function deferredSessionSetup(): Readonly<{
  model: DeferredAgentModel;
  setup: ReturnType<typeof connectedSessionSetup>;
}> {
  const model = createDeferredAgentModel();
  return { model, setup: connectedSessionSetup(model) };
}
