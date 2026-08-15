import type {
  AgentReasoningEffort,
  OpenRouterProviderRouting,
} from "../shared/agent-configuration.ts";
import type {
  AgentSessionToolName,
  AgentToolDefinition,
} from "../shared/agent-tools.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { anthropicRequestBody } from "./anthropic-request.ts";
import {
  providerChatMessage,
  providerResponsesInput,
} from "./provider-attachment-input.ts";
import {
  promptCacheBreakpoints,
  withPromptCacheControl,
} from "./provider-prompt-cache.ts";
import type { ProviderModelRequest } from "./provider-request.ts";

function reasoningConfiguration(
  provider: ProviderId,
  codexOAuth: boolean,
  reasoningEffort: AgentReasoningEffort | undefined,
): Readonly<Record<string, unknown>> {
  if (codexOAuth) {
    return {
      reasoning: {
        ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
        summary: "auto",
      },
    };
  }

  if (reasoningEffort === undefined) {
    return {};
  }

  return provider === "openrouter"
    ? { reasoning: { effort: reasoningEffort, summary: "auto" } }
    : { reasoning_effort: reasoningEffort };
}

function toolConfiguration(
  tools: readonly AgentToolDefinition[],
  selectedTools: readonly AgentSessionToolName[],
  responsesProtocol: boolean,
  dynamicToolCache: boolean,
): Readonly<Record<string, unknown>> {
  if (tools.length === 0 || selectedTools.length === 0) {
    return {};
  }
  const toolChoice =
    dynamicToolCache && responsesProtocol
      ? {
          mode: "auto",
          tools: selectedTools.map((name) => ({ name, type: "function" })),
          type: "allowed_tools",
        }
      : "auto";
  return {
    tool_choice: toolChoice,
    tools: responsesProtocol
      ? tools.map(({ function: definition }) => ({
          ...definition,
          type: "function",
        }))
      : tools,
  };
}

function openRouterProviderPreferences(
  routing: OpenRouterProviderRouting | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (routing?.type === "provider") {
    return { allow_fallbacks: false, order: [routing.tag] };
  }
  if (routing?.type === "order") {
    return { order: [routing.tag] };
  }
  if (routing?.type === "no_fallbacks") {
    return { allow_fallbacks: false };
  }
  return routing?.type === "sort" ? { sort: routing.sort } : undefined;
}

// OpenRouter forwards Anthropic-style cache_control markers to providers that
// price cached prefixes and strips them elsewhere. Generic OpenAI-format
// endpoints get plain messages: local runtimes such as Ollama reject array
// content with tool metadata, and only the Anthropic protocol is known to
// honor the markers. OpenAI itself caches automatically, keyed by
// prompt_cache_key.
function chatMessages(request: ProviderModelRequest): readonly unknown[] {
  if (request.provider !== "openrouter") {
    return [
      { content: request.systemPrompt, role: "system" },
      ...request.messages.map((message) => providerChatMessage(message)),
    ];
  }
  const breakpoints = promptCacheBreakpoints(request.messages);
  return [
    {
      content: withPromptCacheControl([
        { text: request.systemPrompt, type: "text" },
      ]),
      role: "system",
    },
    ...request.messages.map((message, index) =>
      providerChatMessage(message, breakpoints.has(index)),
    ),
  ];
}

// prompt_cache_key is an OpenAI parameter; OpenRouter tolerates and may
// forward it, but strict generic OpenAI-compatible servers reject unknown
// fields, so generic requests omit it.
function promptCacheKeyField(
  request: ProviderModelRequest,
): Readonly<Record<string, string>> {
  return request.promptCacheKey === undefined || request.provider === "generic"
    ? {}
    : { prompt_cache_key: request.promptCacheKey };
}

export function agentModelRequestBody(request: ProviderModelRequest): unknown {
  if (request.protocol === "anthropic") {
    return anthropicRequestBody(request);
  }

  const responsesProtocol = request.protocol === "responses";
  const reasoning = reasoningConfiguration(
    request.provider,
    responsesProtocol,
    request.reasoningEffort,
  );
  const tools = toolConfiguration(
    request.tools,
    request.selectedTools,
    responsesProtocol,
    request.dynamicToolCache,
  );

  if (!responsesProtocol) {
    return {
      messages: chatMessages(request),
      model: request.model,
      ...(request.provider === "openrouter" &&
      request.openRouterProviderRouting !== undefined
        ? {
            provider: openRouterProviderPreferences(
              request.openRouterProviderRouting,
            ),
          }
        : {}),
      ...promptCacheKeyField(request),
      ...reasoning,
      ...(request.stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
      ...tools,
    };
  }

  return {
    include: ["reasoning.encrypted_content"],
    input: request.messages.flatMap(providerResponsesInput),
    instructions: request.systemPrompt,
    model: request.model,
    parallel_tool_calls: false,
    ...promptCacheKeyField(request),
    ...reasoning,
    store: false,
    ...(request.stream ? { stream: true } : {}),
    ...tools,
  };
}
