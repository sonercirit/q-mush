import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import type { SessionStore } from "./session-store-interface.ts";
import {
  activeSessionCondition,
  readStoredSessionSnapshots,
} from "./session-store-persistence.ts";
import {
  failInterruptedStoredSession,
  type InterruptedStoredSession,
} from "./session-store-reassignment.ts";

const MIN_SESSION_LIVENESS_GRACE_MS = 60_000;
export const DEFAULT_SESSION_LIVENESS_GRACE_MS = 5 * 60_000;
const SESSION_LIVENESS_CALLBACK_BATCH_SIZE = 100;

export interface SessionLivenessWatchdogOptions {
  readonly cleanup: (detail: AgentSessionDetail) => Promise<void> | void;
  readonly actions: Pick<
    SessionAgentActions,
    "finished" | "reportAll" | "stopChildren"
  >;
  readonly broker: Pick<
    RunnerCommandBroker,
    "cancelSessionCommands" | "sessionCommandPhase"
  >;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly graceMs?: number;
  readonly allowUnsafeTestTiming?: boolean;
  readonly notify: SessionNotification;
  readonly now: () => number;
  readonly runtimes: Pick<
    SessionRuntimes,
    "abortForGeneration" | "activeForGeneration" | "pending"
  >;
  readonly shutdownInterrupted: Pick<
    ShutdownInterruptedSessionStore,
    "recover"
  >;
  readonly store: Pick<SessionStore, "get" | "pendingSpawnedSessions">;
}

interface MissingRuntime {
  readonly generation: number;
  readonly pendingSince: number | undefined;
  readonly reason: MissingRuntimeReason;
  missingSince: number;
}

type MissingRuntimeReason =
  | "missing_runtime"
  | "provider_admission"
  | "queued_command"
  | "runner_disconnected";

const LIVENESS_ERRORS: Readonly<Record<MissingRuntimeReason, string>> = {
  missing_runtime:
    "Session failed: the liveness watchdog found no active runtime driving this running session",
  provider_admission:
    "Session failed: the provider request was not acknowledged during the liveness recovery window",
  queued_command:
    "Session failed: the liveness watchdog found a runner command that could not be dispatched during the recovery window",
  runner_disconnected:
    "Session failed: the assigned runner did not reconnect during the liveness recovery window",
};

export interface SessionLivenessWatchdog {
  runnerConnected(runnerId: string): void;
  runnerDisconnected(runnerId: string): void;
  scan(): void;
}

export function createSessionLivenessWatchdogState(
  suppliedOptions: SessionLivenessWatchdogOptions,
): SessionLivenessWatchdog {
  const missingSessions = new Map<string, MissingRuntime>();
  const connectedRunners = new Set<string>();
  const options = (() => {
    const options = suppliedOptions;
    const graceMs = options.graceMs ?? DEFAULT_SESSION_LIVENESS_GRACE_MS;
    if (
      !Number.isSafeInteger(graceMs) ||
      graceMs < 1 ||
      (!options.allowUnsafeTestTiming &&
        graceMs < MIN_SESSION_LIVENESS_GRACE_MS)
    ) {
      throw new RangeError(
        `The session liveness grace must be at least ${String(MIN_SESSION_LIVENESS_GRACE_MS)} ms`,
      );
    }
    return { ...options, graceMs };
  })();

  const runnerConnected = (runnerId: string): void => {
    connectedRunners.add(runnerId);
  };

  const runnerDisconnected = (runnerId: string): void => {
    connectedRunners.delete(runnerId);
  };

  const scan = (): void => {
    const now = options.now();
    options.shutdownInterrupted.recover(() => now);
    const running: readonly InterruptedStoredSession[] =
      readStoredSessionSnapshots(
        options.database,
        activeSessionCondition({ status: "running" }),
      ).map((session) => ({ ...session, status: "running" }));
    const runningIds = new Set(running.map(({ id }) => id));
    for (const session of running) {
      const observedReason = missingReason(session.id, session.userId);
      if (observedReason === undefined) {
        missingSessions.delete(session.id);
        continue;
      }
      const missing = missingSessions.get(session.id);
      if (
        missing?.generation !== session.executionGeneration ||
        missing.reason !== observedReason.reason ||
        missing.pendingSince !== observedReason.pendingSince
      ) {
        missingSessions.set(session.id, {
          generation: session.executionGeneration,
          missingSince: now,
          pendingSince: observedReason.pendingSince,
          reason: observedReason.reason,
        });
        continue;
      }
      if (now - missing.missingSince < options.graceMs) {
        continue;
      }
      if (!stillMissing(session, missing)) {
        continue;
      }
      fail(session, now, missing);
      missingSessions.delete(session.id);
    }
    for (const sessionId of missingSessions.keys()) {
      if (!runningIds.has(sessionId)) {
        missingSessions.delete(sessionId);
      }
    }
    options.actions.reportAll(
      options.store.pendingSpawnedSessions(
        SESSION_LIVENESS_CALLBACK_BATCH_SIZE,
      ),
    );
  };

  const missingReason = (
    sessionId: string,
    userId: string,
  ):
    | {
        readonly pendingSince: number | undefined;
        readonly reason: MissingRuntimeReason;
      }
    | undefined => {
    const detail = options.store.get(userId, sessionId);
    if (
      detail === undefined ||
      !options.runtimes.activeForGeneration(sessionId, detail.generation)
    ) {
      return { pendingSince: undefined, reason: "missing_runtime" };
    }
    const commandPhase = options.broker.sessionCommandPhase(sessionId);
    if (commandPhase === "runner_disconnected") {
      return { pendingSince: undefined, reason: "runner_disconnected" };
    }
    if (commandPhase === "queued") {
      return { pendingSince: undefined, reason: "queued_command" };
    }
    if (
      commandPhase === "in_flight" &&
      !connectedRunners.has(detail.runnerId)
    ) {
      return { pendingSince: undefined, reason: "runner_disconnected" };
    }
    const pending = options.runtimes.pending(sessionId, detail.generation);
    return pending?.component === "provider_admission"
      ? { pendingSince: pending.since, reason: "provider_admission" }
      : undefined;
  };

  const stillMissing = (
    session: InterruptedStoredSession,
    observed: MissingRuntime,
  ): boolean => {
    const current = missingReason(session.id, session.userId);
    return (
      current?.reason === observed.reason &&
      current.pendingSince === observed.pendingSince
    );
  };

  const fail = (
    session: InterruptedStoredSession,
    now: number,
    missing: MissingRuntime,
  ): void => {
    const error = LIVENESS_ERRORS[missing.reason];
    if (
      !failInterruptedStoredSession(
        options.database,
        session,
        options.generateId(now),
        now,
        error,
      )
    ) {
      return;
    }
    options.broker.cancelSessionCommands(session.id);
    options.runtimes.abortForGeneration(
      session.id,
      session.executionGeneration,
      new DOMException(error, "AbortError"),
    );
    options.broker.cancelSessionCommands(session.id);
    const detail = options.store.get(session.userId, session.id);
    options.notify(session.userId, session.id);
    if (detail === undefined) {
      return;
    }
    void Promise.resolve(options.cleanup(detail)).catch(() => undefined);
    options.actions.stopChildren(detail, session.userId);
    options.actions.finished(detail, session.userId);
  };

  return { runnerConnected, runnerDisconnected, scan };
}
