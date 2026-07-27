import { expect, test } from "vitest";
import {
  maximumAgentReasoningEffort,
  type AgentModelCatalog,
} from "../../shared/agent-configuration.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { SessionDraft } from "../../solid/session-client.tsx";
import {
  applySessionModelCatalog,
  chooseSessionOption,
} from "../../solid/session-selection.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";

const CATALOG: AgentModelCatalog = {
  defaultModel: "powerful",
  models: [
    {
      contextWindow: null,
      id: "balanced",
      inputModalities: null,
      label: "Balanced",
      outputModalities: null,
      pricing: null,
      reasoningEfforts: ["low", "medium"],
    },
    {
      contextWindow: null,
      id: "powerful",
      inputModalities: null,
      label: "Powerful",
      outputModalities: null,
      pricing: null,
      reasoningEfforts: ["max", "low", "xhigh"],
    },
  ],
};

const DRAFT: SessionDraft = {
  autoCompact: true,
  credential: "",
  executionEnvironment: "bare_metal",
  images: [],
  model: "",
  openRouterProviderTag: "",
  prompt: "Inspect the workspace",
  reasoningEffort: "",
  runnerId: "runner-1",
  tools: AGENT_SESSION_TOOL_NAMES,
  workingDirectory: ".",
};

const SELECTED_DRAFT: SessionDraft = {
  ...DRAFT,
  credential: "openai:credential-1",
  model: "powerful",
  reasoningEffort: "low",
};

test("identifies the maximum supported reasoning effort", () => {
  expect(maximumAgentReasoningEffort(["max", "low", "xhigh"])).toBe("max");
  expect(maximumAgentReasoningEffort([])).toBeUndefined();
});

test("defaults a discovered catalog to its first model and maximum reasoning", () => {
  expect(
    applySessionModelCatalog(DRAFT, "openai:credential-1", CATALOG),
  ).toEqual({
    ...DRAFT,
    credential: "openai:credential-1",
    model: "balanced",
    reasoningEffort: "medium",
  });
});

test("resets a previous model choice when a different credential loads", () => {
  expect(
    applySessionModelCatalog(
      SELECTED_DRAFT,
      "openrouter:credential-2",
      CATALOG,
    ),
  ).toEqual({
    ...DRAFT,
    credential: "openrouter:credential-2",
    model: "balanced",
    reasoningEffort: "medium",
  });
});

test("defaults a newly selected model to its maximum reasoning effort", () => {
  const state = {
    ...initialSessionViewState(),
    draft: { ...DRAFT, model: "balanced", reasoningEffort: "low" },
  };

  expect(
    chooseSessionOption(
      state,
      { availableValues: ["powerful"], models: CATALOG },
      "model",
      "powerful",
    ),
  ).toEqual({ ...state.draft, model: "powerful", reasoningEffort: "max" });
});

test("preserves a supported reasoning effort when a catalog refreshes", () => {
  const draft = {
    ...DRAFT,
    credential: "openai:credential-1",
    model: "balanced",
    reasoningEffort: "low",
  };

  expect(
    applySessionModelCatalog(draft, "openai:credential-1", CATALOG),
  ).toEqual({ ...draft, credential: "openai:credential-1" });
});
