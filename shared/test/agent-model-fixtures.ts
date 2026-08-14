import type {
  AgentModelCatalog,
  AgentModelOption,
} from "../agent-configuration.ts";

export function testAgentModelOption(
  overrides: Partial<AgentModelOption> = {},
): AgentModelOption {
  return {
    adaptiveThinking: null,
    contextWindow: 128_000,
    id: "vendor/model",
    inputModalities: ["text"],
    label: "Model",
    maxOutputTokens: null,
    outputModalities: ["text"],
    pricing: null,
    reasoningEfforts: [],
    ...overrides,
  };
}

export function testAgentModelCatalog(
  overrides: Partial<AgentModelOption> = {},
): AgentModelCatalog {
  const model = testAgentModelOption(overrides);
  return { defaultModel: model.id, models: [model] };
}
