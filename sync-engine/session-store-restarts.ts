import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  RestartHandoffStore,
  type RestartHandoffIdentity,
} from "./session-restart-store.ts";
import { SessionStoreRuntime } from "./session-store-runtime.ts";

type RestartToolDatabase = Pick<AppDatabase, "insert" | "select" | "update">;

export abstract class SessionStoreRestarts extends SessionStoreRuntime {
  readonly #restartHandoffs: RestartHandoffStore;

  constructor(database: AppDatabase, generateId: IdGenerator) {
    super();
    this.#restartHandoffs = new RestartHandoffStore({
      database,
      generateId,
      interruptUnknownTools: (transaction, sessionId, now) => {
        this.appendUnknownRestartToolResults(transaction, sessionId, now);
      },
      read: (userId, sessionId) => this.readRestartSession(userId, sessionId),
    });
  }

  protected abstract appendUnknownRestartToolResults(
    database: RestartToolDatabase,
    sessionId: string,
    now: number,
  ): void;

  protected abstract readRestartSession(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined;

  protected restoreInterruptedRestart(
    ...parameters: Parameters<RestartHandoffStore["restoreInterrupted"]>
  ): boolean {
    return this.#restartHandoffs.restoreInterrupted(...parameters);
  }

  pauseQueuedForRestart(
    ...arguments_: Parameters<RestartHandoffStore["pauseQueued"]>
  ): boolean {
    return this.#restartHandoffs.pauseQueued(...arguments_);
  }

  pauseRunningForRestart(
    ...arguments_: Parameters<RestartHandoffStore["pauseRunning"]>
  ): boolean {
    return this.#restartHandoffs.pauseRunning(...arguments_);
  }

  failInvalidRestartHandoff(
    ...arguments_: Parameters<RestartHandoffStore["failInvalid"]>
  ): boolean {
    return this.#restartHandoffs.failInvalid(...arguments_);
  }

  failRestartHandoff(
    ...arguments_: Parameters<RestartHandoffStore["failQueued"]>
  ): boolean {
    return this.#restartHandoffs.failQueued(...arguments_);
  }

  invalidRestartHandoffs(runnerId?: string) {
    return this.#restartHandoffs.invalid(runnerId);
  }

  pendingRestartHandoffs(runnerId?: string) {
    return this.#restartHandoffs.pending(runnerId);
  }

  claimRestartHandoff(
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ): AgentSessionDetail | undefined {
    return this.#restartHandoffs.claim(userId, identity, now);
  }

  settleRestartHandoff(
    userId: string,
    identity: RestartHandoffIdentity,
    settlement: Parameters<RestartHandoffStore["settle"]>[2],
    now: number,
  ): boolean {
    return this.#restartHandoffs.settle(userId, identity, settlement, now);
  }

  restoreRestartHandoff(
    identity: RestartHandoffIdentity,
    now: number,
  ): boolean {
    return this.#restartHandoffs.restore(identity, now);
  }
}
