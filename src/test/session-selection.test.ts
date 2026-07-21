import { expect, test } from "bun:test";
import {
  maximumAgentReasoningEffort,
  type AgentModelCatalog,
} from "../agent-configuration.ts";
import type { SessionDraft } from "../session-client.tsx";
import {
  applySessionModelCatalog,
  chooseSessionOption,
} from "../session-selection.ts";
import { initialSessionViewState } from "../session-state.ts";

const CATALOG: AgentModelCatalog = {
  defaultModel: "balanced",
  models: [
    {
      contextWindow: null,
      id: "balanced",
      inputModalities: null,
      label: "Balanced",
      outputModalities: null,
      reasoningEfforts: ["low", "medium"],
    },
    {
      contextWindow: null,
      id: "powerful",
      inputModalities: null,
      label: "Powerful",
      outputModalities: null,
      reasoningEfforts: ["max", "low", "xhigh"],
    },
  ],
};

const DRAFT: SessionDraft = {
  credential: "",
  images: [],
  model: "",
  prompt: "Inspect the workspace",
  reasoningEffort: "",
  runnerId: "runner-1",
  workingDirectory: ".",
};

test("identifies the maximum supported reasoning effort", () => {
  expect(maximumAgentReasoningEffort(["max", "low", "xhigh"])).toBe("max");
  expect(maximumAgentReasoningEffort([])).toBeUndefined();
});

test("defaults a discovered model to its maximum reasoning effort", () => {
  expect(
    applySessionModelCatalog(DRAFT, "openai:credential-1", CATALOG),
  ).toEqual({
    ...DRAFT,
    credential: "openai:credential-1",
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
  const draft = { ...DRAFT, model: "balanced", reasoningEffort: "low" };

  expect(
    applySessionModelCatalog(draft, "openai:credential-1", CATALOG),
  ).toEqual({ ...draft, credential: "openai:credential-1" });
});
