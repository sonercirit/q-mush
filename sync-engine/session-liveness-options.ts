import type { AgentSessionDetail } from "../shared/session-model.ts";

export interface SessionLivenessCleanupOptions {
  readonly cleanup: (detail: AgentSessionDetail) => Promise<void> | void;
}
