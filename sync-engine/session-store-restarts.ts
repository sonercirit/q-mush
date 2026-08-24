import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  RestartHandoffStore,
  type RestartHandoffIdentity,
} from "./session-restart-store.ts";

type RestartToolDatabase = Pick<AppDatabase, "insert" | "select" | "update">;

interface SessionStoreRestartResources {
  readonly appendUnknownToolResults: (
    database: RestartToolDatabase,
    sessionId: string,
    now: number,
  ) => void;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly read: (
    userId: string,
    sessionId: string,
  ) => AgentSessionDetail | undefined;
}

export interface SessionStoreRestarts {
  readonly claimRestartHandoff: (
    userId: string,
    identity: RestartHandoffIdentity,
    now: number,
  ) => AgentSessionDetail | undefined;
  readonly failInvalidRestartHandoff: RestartHandoffStore["failInvalid"];
  readonly failRestartHandoff: RestartHandoffStore["failQueued"];
  readonly invalidRestartHandoffs: RestartHandoffStore["invalid"];
  readonly pauseQueuedForRestart: RestartHandoffStore["pauseQueued"];
  readonly pauseRunningForRestart: RestartHandoffStore["pauseRunning"];
  readonly pendingRestartHandoffs: RestartHandoffStore["pending"];
  readonly restoreInterruptedRestart: RestartHandoffStore["restoreInterrupted"];
  readonly restoreRestartHandoff: RestartHandoffStore["restore"];
  readonly settleRestartHandoff: RestartHandoffStore["settle"];
}

export function createSessionStoreRestarts(
  resources: SessionStoreRestartResources,
): SessionStoreRestarts {
  const restartHandoffs = RestartHandoffStore({
    database: resources.database,
    generateId: resources.generateId,
    interruptUnknownTools: (transaction, sessionId, now) => {
      resources.appendUnknownToolResults(transaction, sessionId, now);
    },
    read: resources.read,
  });
  return {
    claimRestartHandoff: (userId, identity, now) =>
      restartHandoffs.claim(userId, identity, now),
    failInvalidRestartHandoff: (...parameters) =>
      restartHandoffs.failInvalid(...parameters),
    failRestartHandoff: (...parameters) =>
      restartHandoffs.failQueued(...parameters),
    invalidRestartHandoffs: (runnerId) => restartHandoffs.invalid(runnerId),
    pauseQueuedForRestart: (...parameters) =>
      restartHandoffs.pauseQueued(...parameters),
    pauseRunningForRestart: (...parameters) =>
      restartHandoffs.pauseRunning(...parameters),
    pendingRestartHandoffs: (runnerId) => restartHandoffs.pending(runnerId),
    restoreInterruptedRestart: (...parameters) =>
      restartHandoffs.restoreInterrupted(...parameters),
    restoreRestartHandoff: (...parameters) =>
      restartHandoffs.restore(...parameters),
    settleRestartHandoff: (...parameters) =>
      restartHandoffs.settle(...parameters),
  };
}
