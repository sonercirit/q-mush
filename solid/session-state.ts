import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../shared/agent-tools.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { initialDirectoryPickerState } from "./directory-picker-controller.ts";
import type {
  SessionDraft,
  SessionModelDiscoveryState,
  SessionViewState,
} from "./session-client.tsx";

export function mostRecentSessionDirectory(
  sessions: readonly Pick<AgentSessionSummary, "workingDirectory">[],
): string {
  return sessions[0]?.workingDirectory ?? ".";
}

function initialSessionDraft(): SessionDraft {
  return {
    credential: "",
    images: [],
    model: "",
    prompt: "",
    reasoningEffort: "",
    runnerId: "",
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
    sessionsSource: undefined,
    stopping: false,
  };
}
