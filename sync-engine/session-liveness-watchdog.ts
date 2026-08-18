import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionLivenessCleanupOptions } from "./session-liveness-options.ts";
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

interface SessionLivenessWatchdogOptions extends SessionLivenessCleanupOptions {
  readonly actions: Pick<
    SessionAgentActions,
    "finished" | "reportAll" | "stopChildren"
  >;
  readonly broker: Pick<
    RunnerCommandBroker,
    "cancelSession" | "sessionCommandPhase"
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
        missing.reason !== missingReason.reason ||
        missing.pendingSince !== missingReason.pendingSince
      ) {
        this.#missing.set(session.id, {
          generation: session.executionGeneration,
          missingSince: now,
          pendingSince: missingReason.pendingSince,
          reason: missingReason.reason,
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
  ):
    | {
        readonly pendingSince: number | undefined;
        readonly reason: MissingRuntimeReason;
      }
    | undefined {
    const detail = this.#options.store.get(userId, sessionId);
    if (
      detail === undefined ||
      !this.#options.runtimes.activeForGeneration(sessionId, detail.generation)
    ) {
      return { pendingSince: undefined, reason: "missing_runtime" };
    }
    const commandPhase = this.#options.broker.sessionCommandPhase(sessionId);
    if (commandPhase === "runner_disconnected") {
      return { pendingSince: undefined, reason: "runner_disconnected" };
    }
    if (commandPhase === "queued") {
      return { pendingSince: undefined, reason: "queued_command" };
    }
    if (
      commandPhase === "in_flight" &&
      !this.#connectedRunners.has(detail.runnerId)
    ) {
      return { pendingSince: undefined, reason: "runner_disconnected" };
    }
    const pending = this.#options.runtimes.pending(
      sessionId,
      detail.generation,
    );
    return pending?.component === "provider_admission"
      ? { pendingSince: pending.since, reason: "provider_admission" }
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
    this.#options.runtimes.abortForGeneration(
      session.id,
      session.executionGeneration,
      new DOMException(LIVENESS_ERRORS[reason], "AbortError"),
    );
    this.#options.broker.cancelSession(session.id);
    const detail = this.#options.store.get(session.userId, session.id);
    this.#options.notify(session.userId, session.id);
    if (detail === undefined) {
      return;
    }
    void this.#options.cleanup(detail);
    this.#options.actions.stopChildren(detail, session.userId);
    this.#options.actions.finished(detail, session.userId);
  }
}
