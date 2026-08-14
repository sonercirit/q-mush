import {
  normalizeAgentToolCall,
  type AgentConversationMessage,
  type AgentModelStep,
} from "../shared/agent-loop.ts";
import {
  anthropicReplayMatchesAssistant,
  type AnthropicAssistantReplay,
} from "../shared/anthropic-replay.ts";
export type CompletionArguments = readonly [
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
];

function matchingProviderReplay(
  message: Extract<AgentConversationMessage, { readonly role: "assistant" }>,
  toolCalls: readonly ReturnType<typeof normalizeAgentToolCall>[],
): AnthropicAssistantReplay | undefined {
  const normalized = toolCalls.filter((call) => call !== undefined);
  return message.providerReplay !== undefined &&
    anthropicReplayMatchesAssistant(
      message.providerReplay,
      message.content,
      normalized,
    )
    ? message.providerReplay
    : undefined;
}

export function completionMessages(
  parameters: CompletionArguments,
): readonly AgentConversationMessage[] {
  const messages = parameters[0];
  const sanitized: AgentConversationMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "compaction_notice") {
      continue;
    }
    if (message.role === "tool") {
      continue;
    }
    if (message.role !== "assistant") {
      sanitized.push(message);
      continue;
    }

    const followingResults: Extract<
      AgentConversationMessage,
      { readonly role: "tool" }
    >[] = [];
    for (;;) {
      const result = messages[index + 1];
      if (result?.role !== "tool") {
        break;
      }
      followingResults.push(result);
      index += 1;
    }
    const resultIds = new Set(
      followingResults.map(({ toolCallId }) => toolCallId),
    );
    const emittedCalls = new Set<string>();
    const toolCalls = message.toolCalls
      .map(normalizeAgentToolCall)
      .filter((call) => call !== undefined)
      .filter((call) => {
        if (!resultIds.has(call.id) || emittedCalls.has(call.id)) {
          return false;
        }
        emittedCalls.add(call.id);
        return true;
      });
    const providerReplay = matchingProviderReplay(message, toolCalls);
    if (
      message.content.length > 0 ||
      toolCalls.length > 0 ||
      providerReplay !== undefined
    ) {
      sanitized.push({
        content: message.content,
        ...(providerReplay === undefined ? {} : { providerReplay }),
        role: "assistant",
        toolCalls,
      });
    }
    const callIds = new Set(toolCalls.map(({ id }) => id));
    const emittedResults = new Set<string>();
    sanitized.push(
      ...followingResults.filter(({ toolCallId }) => {
        if (!callIds.has(toolCallId) || emittedResults.has(toolCallId)) {
          return false;
        }
        emittedResults.add(toolCallId);
        return true;
      }),
    );
  }
  return sanitized;
}

export function completionSignal(parameters: CompletionArguments) {
  return parameters[1];
}

export type OptionalStep = AgentModelStep | undefined;
