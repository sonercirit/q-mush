import type { AgentAttachment } from "../shared/agent-attachments.ts";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { RunnerExecutionEnvironment } from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import type { DirectoryPickerState } from "./directory-picker-controller.ts";
import type { SessionHistoryState } from "./session-history-state.ts";
import type { OptimisticPendingInput } from "./session-pending-input.ts";
import type { SessionProviderDiscoveryState } from "./session-provider-select.tsx";
import type { SessionReassignmentDraft } from "./session-reassignment-client.ts";
import type { SessionTranscriptFilters } from "./session-transcript-filters.ts";

export interface SessionDraft {
  readonly agentFilePath?: string;
  readonly autoCompact: boolean;
  readonly credential: string;
  readonly executionEnvironment: RunnerExecutionEnvironment;
  readonly images: readonly AgentAttachment[];
  readonly model: string;
  readonly openRouterProviderTag: string;
  readonly prompt: string;
  readonly reasoningEffort: string;
  readonly runnerId: string;
  readonly tools: readonly AgentSessionToolName[];
  readonly userContextTokenCap: string;
  readonly workingDirectory: string;
}

export interface SessionModelDiscoveryState {
  readonly catalog: AgentModelCatalog | undefined;
  readonly credential: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
}

export interface SessionViewState {
  readonly answeringQuestions: boolean;
  readonly compacting: boolean;
  readonly creating: boolean;
  readonly detail: AgentSessionDetail | undefined;
  readonly directoryPicker: DirectoryPickerState;
  readonly forking: boolean;
  readonly draft: SessionDraft;
  readonly error: string | undefined;
  readonly followUp: string;
  readonly followUpImages: readonly AgentAttachment[];
  readonly history: SessionHistoryState;
  readonly loadingDetail: boolean;
  readonly modelDiscovery: SessionModelDiscoveryState;
  readonly optimisticPendingInputs: readonly OptimisticPendingInput[];
  readonly providerDiscovery: SessionProviderDiscoveryState;
  readonly openSelect:
    | "credential"
    | "executionEnvironment"
    | "model"
    | "openRouterProviderTag"
    | "reasoningEffort"
    | "reassignmentRunnerId"
    | "runnerId"
    | undefined;
  readonly reassigning: boolean;
  readonly reassignment: SessionReassignmentDraft;
  readonly selectedId: string | undefined;
  readonly sending: boolean;
  readonly sessions: readonly AgentSessionSummary[] | undefined;
  readonly stopping: boolean;
  readonly toolStreams: readonly ToolStreamEntry[];
  readonly updatingTools: boolean;
  readonly toolUpdateWarning: string | null;
  readonly transcriptFilters: SessionTranscriptFilters;
}
