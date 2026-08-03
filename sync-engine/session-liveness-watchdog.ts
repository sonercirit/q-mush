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

export const DEFAULT_SESSION_LIVENESS_GRACE_MS = 5 * 60_000;

interface SessionLivenessWatchdogOptions {
  readonly actions: Pick<
    SessionAgentActions,
    "finished" | "reportAll" | "stopChildren"
  >;
  readonly broker: Pick<RunnerCommandBroker, "hasSessionCommand">;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly graceMs?: number;
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
  missingSince: number;
}

const MISSING_RUNTIME_ERROR =
  "Session failed: the liveness watchdog found no active runtime driving this running session";

export class SessionLivenessWatchdog {
  readonly #options: SessionLivenessWatchdogOptions;
  readonly #missing = new Map<string, MissingRuntime>();
  readonly #connectedRunners = new Set<string>();

  constructor(options: SessionLivenessWatchdogOptions) {
    const graceMs = options.graceMs ?? DEFAULT_SESSION_LIVENESS_GRACE_MS;
    if (!Number.isSafeInteger(graceMs) || graceMs < 1) {
      throw new RangeError("The session liveness grace must be positive");
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
      if (this.#backedByLiveRuntime(session.id, session.userId)) {
        this.#missing.delete(session.id);
        continue;
      }
      const missing = this.#missing.get(session.id);
      if (missing?.generation !== session.executionGeneration) {
        this.#missing.set(session.id, {
          generation: session.executionGeneration,
          missingSince: now,
        });
        continue;
      }
      if (now - missing.missingSince < (this.#options.graceMs ?? 0)) {
        continue;
      }
      this.#fail(session, now);
      this.#missing.delete(session.id);
    }
    for (const sessionId of this.#missing.keys()) {
      if (!runningIds.has(sessionId)) {
        this.#missing.delete(sessionId);
      }
    }
    this.#options.actions.reportAll(
      this.#options.store.pendingSpawnedSessions(),
    );
  }

  #backedByLiveRuntime(sessionId: string, userId: string): boolean {
    const detail = this.#options.store.get(userId, sessionId);
    if (
      detail === undefined ||
      !this.#options.runtimes.activeForGeneration(sessionId, detail.generation)
    ) {
      return false;
    }
    return (
      !this.#options.broker.hasSessionCommand(sessionId) ||
      this.#connectedRunners.has(detail.runnerId)
    );
  }

  #fail(session: InterruptedStoredSession, now: number): void {
    if (
      !failInterruptedStoredSession(
        this.#options.database,
        session,
        this.#options.generateId(now),
        now,
        MISSING_RUNTIME_ERROR,
      )
    ) {
      return;
    }
    const detail = this.#options.store.get(session.userId, session.id);
    this.#options.notify(session.userId, session.id);
    if (detail === undefined) {
      return;
    }
    this.#options.actions.stopChildren(detail, session.userId);
    this.#options.actions.finished(detail, session.userId);
  }
}
