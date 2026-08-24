import type { RestartDeadline } from "../shared/restart-deadline.ts";
import type { SessionIntegration } from "./session-integration.ts";

type DevelopmentRestartSessions = Pick<
  SessionIntegration,
  "drain" | "escalateDrain" | "restoreDevelopmentDrainRecovery"
>;

interface DevelopmentRestartLifecycleOptions {
  readonly drainFailed: (error: unknown) => void;
  readonly drainReady: () => void;
  readonly drainSettled: () => void;
  readonly drainStarted: () => void;
  readonly sessions: DevelopmentRestartSessions;
  readonly startMaintenance: () => void;
  readonly stopMaintenance: () => void;
}

/**
 * Owns the development-restart lifecycle: drain rejection, database
 * maintenance suspension/restoration and the shutdown state a surviving
 * process needs so later restart requests are still accepted.
 */
export interface DevelopmentRestartLifecycle {
  readonly restarting: boolean;
  /** Returns false when the final shutdown already started. */
  beginFinalShutdown(): boolean;
  restart(deadline: RestartDeadline): Promise<void>;
}

export function createDevelopmentRestartLifecycle(
  options: DevelopmentRestartLifecycleOptions,
): DevelopmentRestartLifecycle {
  let kind: "development_restart" | "final" | undefined;
  let pending: Promise<void> | undefined;
  const drain = async (deadline: RestartDeadline): Promise<void> => {
    try {
      await options.sessions.drain(deadline);
    } catch (error) {
      pending = undefined;
      // A final shutdown that started while this drain was in flight already
      // stopped maintenance and closed the restart gate on purpose, so the
      // abandoned development restart must not undo any of it.
      if (kind === "final") {
        options.drainFailed(error);
        return;
      }
      // The process keeps serving traffic, so every irreversible step the
      // drain took has to be undone before normal operation resumes.
      options.sessions.restoreDevelopmentDrainRecovery();
      options.startMaintenance();
      kind = undefined;
      options.drainFailed(error);
      return;
    }
    options.drainReady();
  };
  return {
    get restarting() {
      return kind === "development_restart";
    },
    beginFinalShutdown() {
      if (kind === "final") return false;
      kind = "final";
      options.stopMaintenance();
      return true;
    },
    restart(deadline) {
      if (kind === "final") return Promise.resolve();
      if (pending !== undefined) {
        options.sessions.escalateDrain();
        return pending;
      }
      kind = "development_restart";
      options.stopMaintenance();
      options.drainStarted();
      pending = drain(deadline).finally(options.drainSettled);
      return pending;
    },
  };
}
