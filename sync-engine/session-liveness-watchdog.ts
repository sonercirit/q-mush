import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import {
  activeSessionCondition,
  readStoredSessionSnapshots,
} from "./session-store-persistence.ts";
import {
  failInterruptedStoredSession,
  type InterruptedStoredSession,
} from "./session-store-reassignment.ts";
import type { SessionStore } from "./session-store.ts";

const MIN_SESSION_LIVENESS_GRACE_MS = 60_000;
export const DEFAULT_SESSION_LIVENESS_GRACE_MS = 5 * 60_000;
const SESSION_LIVENESS_CALLBACK_BATCH_SIZE = 100;

interface SessionLivenessWatchdogOptions {
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
  readonly runtimes: Pick<SessionRuntimes, "activeForGeneration">;
  readonly shutdownInterrupted: Pick<
    ShutdownInterruptedSessionStore,
    "recover"
  >;
  readonly store: Pick<SessionStore, "get" | "pendingSpawnedSessions">;
}

interface MissingRuntime {
  readonly generation: number;
  readonly reason: MissingRuntimeReason;
  missingSince: number;
}

type MissingRuntimeReason =
  "missing_runtime" | "queued_command" | "runner_disconnected";

const LIVENESS_ERRORS: Readonly<Record<MissingRuntimeReason, string>> = {
  missing_runtime:
    "Session failed: the liveness watchdog found no active runtime driving this running session",
  queued_command:
    "Session failed: the liveness watchdog found a runner command that could not be dispatched during the recovery window",
  runner_disconnected:
    "Session failed: the assigned runner did not reconnect during the liveness recovery window",
};

export class SessionLivenessWatchdog {
  readonly #options: SessionLivenessWatchdogOptions;
  readonly #missing = new Map<string, MissingRuntime>();
  readonly #connectedRunners = new Set<string>();

  constructor(options: SessionLivenessWatchdogOptions) {
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
    this.#options = { ...options, graceMs };
  }

  runnerConnected(runnerId: string): void {
    this.#connectedRunners.add(runnerId);
  }

  runnerDisconnected(runnerId: string): void {
    this.#connectedRunners.delete(runnerId);
  }

  scan(): void {
    const now = this.#options.now();
    this.#options.shutdownInterrupted.recover(() => now);
    const running: readonly InterruptedStoredSession[] =
      readStoredSessionSnapshots(
        this.#options.database,
        activeSessionCondition({ status: "running" }),
      ).map((session) => ({ ...session, status: "running" }));
    const runningIds = new Set(running.map(({ id }) => id));
    for (const session of running) {
      const missingReason = this.#missingReason(session.id, session.userId);
      if (missingReason === undefined) {
        this.#missing.delete(session.id);
        continue;
      }
      const missing = this.#missing.get(session.id);
      if (
        missing?.generation !== session.executionGeneration ||
        missing.reason !== missingReason
      ) {
        this.#missing.set(session.id, {
          generation: session.executionGeneration,
          missingSince: now,
          reason: missingReason,
        });
        continue;
      }
      if (now - missing.missingSince < (this.#options.graceMs ?? 0)) {
        continue;
      }
      this.#fail(session, now, missing.reason);
      this.#missing.delete(session.id);
    }
    for (const sessionId of this.#missing.keys()) {
      if (!runningIds.has(sessionId)) {
        this.#missing.delete(sessionId);
      }
    }
    this.#options.actions.reportAll(
      this.#options.store.pendingSpawnedSessions(
        SESSION_LIVENESS_CALLBACK_BATCH_SIZE,
      ),
    );
  }

  #missingReason(
    sessionId: string,
    userId: string,
  ): MissingRuntimeReason | undefined {
    const detail = this.#options.store.get(userId, sessionId);
    if (
      detail === undefined ||
      !this.#options.runtimes.activeForGeneration(sessionId, detail.generation)
    ) {
      return "missing_runtime";
    }
    const commandPhase = this.#options.broker.sessionCommandPhase(sessionId);
    if (commandPhase === "runner_disconnected") {
      return "runner_disconnected";
    }
    if (commandPhase === "queued") {
      return "queued_command";
    }
    return commandPhase === "in_flight" &&
      !this.#connectedRunners.has(detail.runnerId)
      ? "runner_disconnected"
      : undefined;
  }

  #fail(
    session: InterruptedStoredSession,
    now: number,
    reason: MissingRuntimeReason,
  ): void {
    if (
      !failInterruptedStoredSession(
        this.#options.database,
        session,
        this.#options.generateId(now),
        now,
        LIVENESS_ERRORS[reason],
      )
    ) {
      return;
    }
    this.#options.broker.cancelSessionCommands(session.id);
    const detail = this.#options.store.get(session.userId, session.id);
    this.#options.notify(session.userId, session.id);
    if (detail === undefined) {
      return;
    }
    this.#options.actions.stopChildren(detail, session.userId);
    this.#options.actions.finished(detail, session.userId);
  }
}
