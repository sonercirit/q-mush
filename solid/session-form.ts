import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionDraft } from "./session-draft.ts";
import {
  applySessionModelCatalog,
  chooseSessionOption,
} from "./session-selection.ts";

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
