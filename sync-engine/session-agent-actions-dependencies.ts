import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import type { SessionControlActionDependencies } from "./session-agent-control.ts";
import type { SessionRunnerPageRequest } from "./session-agent-options-action.ts";
import type { SessionOptionsSource } from "./session-agent-options.ts";
import type {
  RunnerDirectoryBrowseResult,
  RunnerDirectoryRequest,
} from "./session-request-helpers.ts";

export type SessionRunnerOptionsLookup = (
  userId: string,
  request: SessionRunnerPageRequest,
) => {
  readonly items: SessionOptionsSource["runners"];
  readonly totalItems: number;
};

export interface SessionAgentActionsDependencies
  extends SessionAgentActionDependencies, SessionControlActionDependencies {
  readonly abortSession: (sessionId: string) => void;
  readonly activeSession: (sessionId: string) => boolean;
  readonly broker: Pick<RunnerCommandBroker, "cancelSessionCommands">;
  readonly cleanupSession: (detail: AgentSessionDetail) => void;
  readonly browseDirectories: (
    request: RunnerDirectoryRequest,
    signal: AbortSignal,
  ) => Promise<RunnerDirectoryBrowseResult>;
  readonly listOnlineRunners: (
    userId: string,
    workspaceId?: string,
  ) => readonly RunnerSummary[];
  readonly listRunnerOptions: SessionRunnerOptionsLookup;
}
