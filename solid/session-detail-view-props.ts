import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";

export interface SessionDetailViewProps {
  readonly controller: SessionController;
  readonly credentialAvailable?: boolean | undefined;
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly state: SessionViewState;
}

export interface LoadedSessionDetailViewProps extends Omit<
  SessionDetailViewProps,
  "credentialAvailable"
> {
  readonly credentialAvailable: boolean | undefined;
  readonly detail: AgentSessionDetail;
}
