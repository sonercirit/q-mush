import type { SessionForkSelection } from "../shared/session-fork.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { SessionCredentialOption } from "./session-credential-option.ts";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";

interface SessionForkController {
  fork(messageId: string, selection?: SessionForkSelection): Promise<void>;
}

type SessionDetailForkController = SessionRunnerViewProps["controller"] &
  SessionForkController;

export interface SessionDetailViewProps extends Omit<
  SessionRunnerViewProps,
  "controller"
> {
  readonly controller: SessionDetailForkController;
  readonly credentialAvailable?: boolean | undefined;
  readonly credentials: readonly SessionCredentialOption[];
  readonly toolSettings?: ToolSettings | undefined;
}

export interface LoadedSessionDetailViewProps extends Omit<
  SessionDetailViewProps,
  "credentialAvailable"
> {
  readonly credentialAvailable: boolean | undefined;
  readonly detail: AgentSessionDetail;
}
