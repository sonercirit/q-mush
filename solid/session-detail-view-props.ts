import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionCredentialOption } from "./session-credential-option.ts";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";

export interface SessionDetailViewProps extends SessionRunnerViewProps {
  readonly credentialAvailable?: boolean | undefined;
  readonly credentials: readonly SessionCredentialOption[];
}

export interface LoadedSessionDetailViewProps extends Omit<
  SessionDetailViewProps,
  "credentialAvailable"
> {
  readonly credentialAvailable: boolean | undefined;
  readonly detail: AgentSessionDetail;
}
