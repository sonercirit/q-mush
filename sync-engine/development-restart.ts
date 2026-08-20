import type { RestartDeadline } from "../shared/restart-deadline.ts";
import type { SessionIntegration } from "./session-integration.ts";

export async function drainDevelopmentRestart(
  sessions: Pick<
    SessionIntegration,
    "drain" | "restoreDevelopmentDrainRecovery"
  >,
  deadline: RestartDeadline,
  rejected: (error: unknown) => void,
): Promise<boolean> {
  try {
    await sessions.drain(deadline);
    return true;
  } catch (error) {
    sessions.restoreDevelopmentDrainRecovery();
    rejected(error);
    return false;
  }
}
