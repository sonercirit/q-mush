import {
  maximumAgentReasoningEffort,
  type AgentModelCatalog,
  type AgentModelOption,
} from "./agent-configuration.ts";
import type { SessionDraft, SessionViewState } from "./session-client.tsx";

function selectedModel(
  catalog: AgentModelCatalog | undefined,
  id: string,
): AgentModelOption | undefined {
  return catalog?.models.find((option) => option.id === id);
}

interface SessionOptionSelection {
  readonly availableValues: readonly string[];
  readonly models: AgentModelCatalog | undefined;
}

export function chooseSessionOption(
  state: SessionViewState,
  selection: SessionOptionSelection,
  name: string,
  value: string,
): SessionDraft | undefined {
  if (name === "runnerId") {
    return selection.availableValues.includes(value)
      ? { ...state.draft, runnerId: value }
      : undefined;
  }

  if (name === "credential") {
    return selection.availableValues.includes(value)
      ? {
          ...state.draft,
          credential: value,
          model: "",
          reasoningEffort: "",
        }
      : undefined;
  }

  if (name === "model") {
    const model = selectedModel(selection.models, value);
    return model === undefined
      ? undefined
      : {
          ...state.draft,
          model: model.id,
          reasoningEffort:
            maximumAgentReasoningEffort(model.reasoningEfforts) ?? "",
        };
  }

  if (name !== "reasoningEffort") {
    return undefined;
  }

  const model = selectedModel(selection.models, state.draft.model);
  const supported =
    value.length === 0 ||
    model?.reasoningEfforts.some((effort) => effort === value) === true;
  return supported ? { ...state.draft, reasoningEffort: value } : undefined;
}

export function applySessionModelCatalog(
  current: SessionDraft,
  credential: string,
  catalog: AgentModelCatalog,
): SessionDraft {
  const model = catalog.models.some(({ id }) => id === current.model)
    ? current.model
    : (catalog.defaultModel ?? catalog.models[0]?.id ?? "");
  const efforts = catalog.models.find(
    ({ id }) => id === model,
  )?.reasoningEfforts;
  const reasoningEffort =
    efforts?.some((effort) => effort === current.reasoningEffort) === true
      ? current.reasoningEffort
      : (maximumAgentReasoningEffort(efforts ?? []) ?? "");
  return { ...current, credential, model, reasoningEffort };
}
