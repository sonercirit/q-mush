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
export class DevelopmentRestartLifecycle {
  readonly #options: DevelopmentRestartLifecycleOptions;
  #kind: "development_restart" | "final" | undefined;
  #pending: Promise<void> | undefined;

  constructor(options: DevelopmentRestartLifecycleOptions) {
    this.#options = options;
  }

  get restarting(): boolean {
    return this.#kind === "development_restart";
  }

  /** Returns false when the final shutdown already started. */
  beginFinalShutdown(): boolean {
    if (this.#kind === "final") return false;
    this.#kind = "final";
    this.#options.stopMaintenance();
    return true;
  }

  restart(deadline: RestartDeadline): Promise<void> {
    if (this.#kind === "final") return Promise.resolve();
    if (this.#pending !== undefined) {
      this.#options.sessions.escalateDrain();
      return this.#pending;
    }
    this.#kind = "development_restart";
    this.#options.stopMaintenance();
    this.#options.drainStarted();
    this.#pending = this.#drain(deadline).finally(this.#options.drainSettled);
    return this.#pending;
  }

  async #drain(deadline: RestartDeadline): Promise<void> {
    try {
      await this.#options.sessions.drain(deadline);
    } catch (error) {
      this.#pending = undefined;
      // A final shutdown that started while this drain was in flight already
      // stopped maintenance and closed the restart gate on purpose, so the
      // abandoned development restart must not undo any of it.
      if (this.#kind === "final") {
        this.#options.drainFailed(error);
        return;
      }
      // The process keeps serving traffic, so every irreversible step the
      // drain took has to be undone before normal operation resumes.
      this.#options.sessions.restoreDevelopmentDrainRecovery();
      this.#options.startMaintenance();
      this.#kind = undefined;
      this.#options.drainFailed(error);
      return;
    }
    this.#options.drainReady();
  }
}
