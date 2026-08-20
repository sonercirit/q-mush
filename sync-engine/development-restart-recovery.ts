import type { SessionIntegration } from "./session-integration.ts";

export function restoreRejectedDevelopmentDrainRecovery(
  sessions: Pick<SessionIntegration, "restoreDevelopmentDrainRecovery">,
): void {
  sessions.restoreDevelopmentDrainRecovery();
}
