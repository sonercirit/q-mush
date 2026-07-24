import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";

export interface SessionDetailViewProps extends SessionRunnerViewProps {
  readonly credentialAvailable?: boolean | undefined;
}

export interface LoadedSessionDetailViewProps extends Omit<
  SessionDetailViewProps,
  "credentialAvailable"
> {
  readonly credentialAvailable: boolean | undefined;
  readonly detail: AgentSessionDetail;
}
