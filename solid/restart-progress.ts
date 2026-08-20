import type { DevelopmentRestartProgress } from "../shared/development-shutdown.ts";
import { restartProgressReport } from "../shared/restart-progress.ts";

export function restartProgressNotice(
  progress: readonly DevelopmentRestartProgress[] | undefined,
): string | undefined {
  if (progress === undefined) return undefined;
  if (progress.length === 0) {
    return "Development restart is finishing; no sessions are still draining.";
  }
  const sessions = restartProgressReport(progress, ": ");
  return `Development restart is waiting for ${String(progress.length)} session(s): ${sessions}`;
}
