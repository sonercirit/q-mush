import type { AgentModelCatalog } from "./agent-configuration.ts";
import { initialDirectoryPickerState } from "./directory-picker-controller.ts";
import type {
  SessionDraft,
  SessionModelDiscoveryState,
  SessionViewState,
} from "./session-client.tsx";

function initialSessionDraft(): SessionDraft {
  return {
    credential: "",
    images: [],
    model: "",
    prompt: "",
    reasoningEffort: "",
    runnerId: "",
    workingDirectory: ".",
  };
}

export function sessionModelDiscoveryState(
  credential: string | undefined,
  loading: boolean,
  catalog?: AgentModelCatalog,
  error?: string,
): SessionModelDiscoveryState {
  return { catalog, credential, error, loading };
}

export function initialSessionViewState(): SessionViewState {
  return {
    compacting: false,
    creating: false,
    detail: undefined,
    directoryPicker: initialDirectoryPickerState(),
    draft: initialSessionDraft(),
    error: undefined,
    followUp: "",
    followUpImages: [],
    loadingDetail: false,
    modelDiscovery: sessionModelDiscoveryState(undefined, false),
    openSelect: undefined,
    selectedId: undefined,
    sending: false,
    sessions: undefined,
    stopping: false,
  };
}
