import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

interface SessionRealtimeActionOptions<Input> {
  readonly input: Input;
  readonly user: AuthenticatedUser;
}

export interface WorkspaceSessionRealtimeActionOptions<
  Input,
> extends SessionRealtimeActionOptions<Input> {
  readonly workspaceId: string;
}

export type SessionRealtimeActionResult = Promise<AgentSessionDetail>;
