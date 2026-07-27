import type { AgentImage } from "./agent-images.ts";
import type { AgentSessionPendingInputKind } from "./session-model.ts";

export interface SessionPendingInputRequest {
  readonly clientRequestId: string;
  readonly images: readonly AgentImage[];
  readonly kind: AgentSessionPendingInputKind;
}

export interface SessionPendingInputContent extends SessionPendingInputRequest {
  readonly content: string;
}
