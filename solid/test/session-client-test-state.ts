import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { SessionViewState } from "../session-client.tsx";
import { initialSessionViewState } from "../session-state.ts";

export function sessionClientTestState(): SessionViewState {
  const initial = initialSessionViewState();
  return {
    ...initial,
    draft: {
      ...initial.draft,
      credential: "openai:credential-1",
      model: "gpt-5-codex",
      reasoningEffort: "high",
      runnerId: "runner-1",
      tools: AGENT_SESSION_TOOL_NAMES,
    },
    modelDiscovery: {
      catalog: {
        defaultModel: "gpt-5-codex",
        models: [
          {
            adaptiveThinking: null,
            contextWindow: 200_000,
            id: "gpt-5-codex",
            inputModalities: ["text", "image", "audio"],
            label: "GPT-5 Codex (discovered)",
            maxOutputTokens: null,
            outputModalities: ["text"],
            pricing: null,
            reasoningEfforts: ["medium", "high", "xhigh"],
          },
          {
            adaptiveThinking: null,
            contextWindow: 64_000,
            id: "image-model",
            inputModalities: ["image"],
            label: "Image Model",
            maxOutputTokens: null,
            outputModalities: ["image"],
            pricing: null,
            reasoningEfforts: [],
          },
        ],
      },
      credential: "openai:credential-1",
      error: undefined,
      loading: false,
    },
    openSelect: "model",
    sessions: [],
  };
}
