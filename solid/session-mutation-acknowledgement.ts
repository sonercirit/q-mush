import type { AgentSessionDetail } from "../shared/session-model.ts";

export type SessionMutationAcknowledgement =
  | { readonly detail: AgentSessionDetail; readonly status: "committed" }
  | { readonly status: "uncertain" };
