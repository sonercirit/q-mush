import type { AgentSessionStatus } from "../shared/session-model.ts";

export interface SessionTransitionInput {
  readonly clearRestartHandoff?: boolean;
  readonly generation?: number;
  readonly now: number;
  readonly sessionId: string;
  readonly userId?: string;
}

export interface SessionStatusTransition extends SessionTransitionInput {
  readonly from: readonly AgentSessionStatus[];
  readonly status: AgentSessionStatus;
}
