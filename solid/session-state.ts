import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../shared/agent-tools.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { initialDirectoryPickerState } from "./directory-picker-controller.ts";
import type {
  SessionDraft,
  SessionModelDiscoveryState,
  SessionViewState,
} from "./session-client.tsx";
import { initialSessionHistoryState } from "./session-history-state.ts";
import type { SessionProviderDiscoveryState } from "./session-provider-select.tsx";
import { emptySessionReassignmentDraft } from "./session-reassignment-client.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "./session-transcript-filters.ts";

export function mostRecentSessionDirectory(
  sessions: readonly Pick<AgentSessionSummary, "workingDirectory">[],
): string {
  return sessions[0]?.workingDirectory ?? ".";
}

function initialSessionDraft(): SessionDraft {
  const emptySelection = "";
  return {
    autoCompact: true,
    credential: emptySelection,
    executionEnvironment: "bare_metal",
    images: [],
    model: emptySelection,
    openRouterProviderTag: emptySelection,
    prompt: emptySelection,
    reasoningEffort: emptySelection,
    runnerId: emptySelection,
    tools: AGENT_SESSION_TOOL_NAMES,
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

export function sessionProviderDiscoveryState(
  key: string | undefined,
  loading: boolean,
  catalog?: SessionProviderDiscoveryState["catalog"],
  error?: string,
): SessionProviderDiscoveryState {
  return { catalog, error, key, loading };
}

export function initialSessionViewState(): SessionViewState {
  return {
    answeringQuestions: false,
    compacting: false,
    creating: false,
    detail: undefined,
    directoryPicker: initialDirectoryPickerState(),
    draft: initialSessionDraft(),
    error: undefined,
    followUp: "",
    followUpImages: [],
    history: initialSessionHistoryState(),
    loadingDetail: false,
    modelDiscovery: sessionModelDiscoveryState(undefined, false),
    providerDiscovery: sessionProviderDiscoveryState(undefined, false),
    openSelect: undefined,
    reassigning: false,
    reassignment: emptySessionReassignmentDraft(),
    selectedId: undefined,
    sending: false,
    sessions: undefined,
    stopping: false,
    toolStreams: [],
    updatingTools: false,
    toolUpdateWarning: null,
    transcriptFilters: { ...DEFAULT_SESSION_TRANSCRIPT_FILTERS },
  };
}
