import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";

export type SessionCredentialOperation = (
  userId: string,
  detail: AgentSessionDetail,
  action: SessionCredentialAction,
) => Promise<Response>;
