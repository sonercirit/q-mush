import type {
  AgentSessionPendingInputKind,
  AttachmentContentFields,
} from "./session-model.ts";

export interface SessionPendingInputRequest extends AttachmentContentFields {
  readonly clientRequestId: string;
  readonly kind: AgentSessionPendingInputKind;
}

export interface SessionPendingInputContent extends SessionPendingInputRequest {
  readonly content: string;
}
