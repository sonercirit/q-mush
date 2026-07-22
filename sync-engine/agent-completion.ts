import type {
  AgentConversationMessage,
  AgentModelTurn,
} from "../shared/agent-loop.ts";
export type CompletionArguments = readonly [
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
];

export function completionMessages(parameters: CompletionArguments) {
  return parameters[0];
}

export function completionSignal(parameters: CompletionArguments) {
  return parameters[1];
}

export type OptionalTurn = AgentModelTurn | undefined;
