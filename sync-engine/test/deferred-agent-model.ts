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
  const model = createDeferredAgentModel();
  return { model, setup: connectedSessionSetup(model) };
}

export interface DeferredAgentModel extends AgentModel {
  readonly requests: AgentConversationMessage[][];
  resolve(step: AgentModelStep): void;
  resolveContent(content: string): void;
}

export function createDeferredAgentModel(): DeferredAgentModel {
  const requests: AgentConversationMessage[][] = [];
  const result = Promise.withResolvers<AgentModelStep>();
  return {
    complete(messages): Promise<AgentModelStep> {
      recordAgentModelRequest(requests, messages);
      return result.promise;
    },
    requests,
    resolve(step): void { result.resolve(step); },
    resolveContent(content): void { result.resolve(terminalAgentStep(content)); },
  };
}
