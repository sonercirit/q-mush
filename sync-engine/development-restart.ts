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
      // Final shutdown deliberately keeps maintenance stopped and the gate closed.
      if (kind === "final") {
        options.drainFailed(error);
        return;
      }
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
