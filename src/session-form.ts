import type { AgentModelCatalog } from "./agent-configuration.ts";
import type { SessionDraft, SessionViewState } from "./session-client.tsx";
import {
  applySessionModelCatalog,
  chooseSessionOption,
} from "./session-selection.ts";

export function formString(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : "";
}

export function readSessionDraft(
  form: HTMLFormElement,
  current: SessionDraft,
): SessionDraft {
  return {
    credential: formString(form, "credential"),
    images: current.images,
    model: formString(form, "model"),
    prompt: formString(form, "prompt"),
    reasoningEffort: formString(form, "reasoningEffort"),
    runnerId: formString(form, "runnerId"),
    workingDirectory: formString(form, "workingDirectory"),
  };
}

export function selectedDraftOption(
  state: SessionViewState,
  name: string,
  value: string,
  availableValues: readonly string[],
): SessionDraft | undefined {
  return chooseSessionOption(
    state,
    { availableValues, models: state.modelDiscovery.catalog },
    name,
    value,
  );
}

export function draftWithModelCatalog(
  state: SessionViewState,
  credential: string,
  catalog: AgentModelCatalog,
): SessionDraft {
  return applySessionModelCatalog(state.draft, credential, catalog);
}
