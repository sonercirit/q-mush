import type { AppDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionDependencies } from "./session-dependencies.ts";
import {
  DEFAULT_SESSION_LIVENESS_GRACE_MS,
  SessionLivenessWatchdog,
} from "./session-liveness-watchdog.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import type { SessionStore } from "./session-store.ts";

const DEFAULT_SESSION_LIVENESS_INTERVAL_MS = 30_000;
const MIN_SESSION_LIVENESS_INTERVAL_MS = 10_000;

interface SessionLivenessSchedulerOptions {
  readonly actions: Pick<
    SessionAgentActions,
    "finished" | "reportAll" | "stopChildren"
  >;
  readonly broker: RunnerCommandBroker;
  readonly database: AppDatabase;
  readonly dependencies: SessionDependencies;
  readonly notify: SessionNotification;
  readonly now: () => number;
  readonly runtimes: SessionRuntimes;
  readonly shutdownInterrupted: ShutdownInterruptedSessionStore;
  readonly store: SessionStore;
}

export interface SessionLiveness {
  readonly stop: () => void;
  readonly watchdog: SessionLivenessWatchdog;
}

export function createSessionLivenessWatchdog(
  options: SessionLivenessSchedulerOptions,
): SessionLiveness {
  const { dependencies } = options;
  const watchdog = new SessionLivenessWatchdog({
    actions: options.actions,
    broker: options.broker,
    database: options.database,
    generateId: dependencies.randomId ?? createUuidV7,
    ...(dependencies.liveness?.allowUnsafeTestTiming === true
      ? { allowUnsafeTestTiming: true }
      : {}),
    ...(dependencies.liveness?.graceMs === undefined
      ? {}
      : { graceMs: dependencies.liveness.graceMs }),
    notify: options.notify,
    now: options.now,
    runtimes: options.runtimes,
    shutdownInterrupted: options.shutdownInterrupted,
    store: options.store,
  });
  const intervalMs =
    dependencies.liveness?.intervalMs ?? DEFAULT_SESSION_LIVENESS_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    (!dependencies.liveness?.allowUnsafeTestTiming &&
      intervalMs < MIN_SESSION_LIVENESS_INTERVAL_MS)
  ) {
    throw new RangeError(
      `The session liveness interval must be at least ${String(MIN_SESSION_LIVENESS_INTERVAL_MS)} ms`,
    );
  }
  const graceMs =
    dependencies.liveness?.graceMs ?? DEFAULT_SESSION_LIVENESS_GRACE_MS;
  if (!dependencies.liveness?.allowUnsafeTestTiming && intervalMs > graceMs) {
    throw new RangeError(
      "The session liveness interval must not exceed the grace period",
    );
  }
  const scan = () => {
    watchdog.scan();
  };
  dependencies.liveness?.testScan?.(scan);
  let clear: () => void;
  if (dependencies.liveness?.setInterval === undefined) {
    const timer = setInterval(scan, intervalMs);
    timer.unref();
    clear = () => {
      clearInterval(timer);
    };
  } else {
    const timer = dependencies.liveness.setInterval(scan, intervalMs);
    const clearInjected = dependencies.liveness.clearInterval;
    clear = () => {
      clearInjected?.(timer);
    };
  }
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clear();
  };
  return { stop, watchdog };
}
