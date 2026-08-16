import {
  readSessionRestartCredential,
  type SessionRestartControl,
} from "./session-restart-control.ts";
import {
  recoverSessionRestartHandoffs,
  type RestartRecoveryBoundary,
} from "./session-restart-recovery.ts";
import type {
  PendingRestartSession,
  RestartHandoffRequester,
} from "./session-restart-store.ts";
import {
  clearRestartTimer,
  setRestartTimer,
  type RestartSetTimeout,
  type RestartTimer,
} from "./session-restart-timers.ts";

const CREDENTIAL_RETRY_DELAY_MS = 1_000;
const CREDENTIAL_RETRY_MAX_DELAY_MS = 60_000;

interface SessionRestartCoordinatorDependencies {
  readonly clearTimeout?: (id: RestartTimer) => void;
  readonly setTimeout?: RestartSetTimeout;
}

export interface SessionRestartCoordinatorOptions extends RestartRecoveryBoundary {
  readonly providers: Parameters<typeof readSessionRestartCredential>[0];
  readonly recoverInterrupted: (runnerId: string) => void;
  readonly restart: SessionRestartControl;
}

interface RestartGate {
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

export type DurableRunnerRestartGate =
  | { readonly status: "none" }
  | ({ readonly status: "pending" } & RestartGate)
  | { readonly status: "conflicted" };

function pendingRestartGate(
  pending: readonly PendingRestartSession[],
): DurableRunnerRestartGate {
  const requests = new Map(
    pending.map(({ handoff }) => [
      `${handoff.requestedBy}:${handoff.restartId}`,
      { requestedBy: handoff.requestedBy, restartId: handoff.restartId },
    ]),
  );
  if (requests.size === 0) {
    return { status: "none" };
  }
  if (requests.size > 1) {
    return { status: "conflicted" };
  }
  const gate = [...requests.values()][0];
  return gate === undefined
    ? { status: "conflicted" }
    : { ...gate, status: "pending" };
}

function durableRunnerRestartGate(
  pending: readonly PendingRestartSession[],
): DurableRunnerRestartGate {
  const gate = pendingRestartGate(pending);
  return gate.status === "pending" && gate.requestedBy === "server"
    ? { status: "none" }
    : gate;
}

function releaseRunnerForRecovery(
  restart: SessionRestartControl,
  runnerId: string,
  restartId: string,
): boolean {
  return restart.resumeRunner(runnerId, restartId);
}

function restartHandoffKey(pending: PendingRestartSession): string {
  return JSON.stringify([
    pending.detail.id,
    pending.detail.generation,
    pending.handoff.executionGeneration,
    pending.handoff.operation,
    pending.handoff.requestedBy,
    pending.handoff.restartId,
  ]);
}

function pendingRestartHandoffKeys(
  pending: readonly PendingRestartSession[],
): ReadonlySet<string> {
  return new Set(pending.map(restartHandoffKey));
}

function restartHandoffsChanged(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): boolean {
  return (
    before.size !== after.size || [...before].some((key) => !after.has(key))
  );
}

export class SessionRestartCoordinator {
  readonly #options: SessionRestartCoordinatorOptions;
  #attempts = new Map<string, number>();
  readonly #clearTimeout: (id: RestartTimer) => void;
  readonly #recoveries = new Map<string, Promise<unknown>>();
  readonly #recoveryRescans = new Set<string>();
  readonly #recoveringInterrupted = new Set<string>();
  readonly #setTimeout: RestartSetTimeout;
  readonly #retryTimers = new Map<string, RestartTimer>();

  constructor(
    options: SessionRestartCoordinatorOptions,
    dependencies: SessionRestartCoordinatorDependencies = {},
  ) {
    this.#options = options;
    this.#clearTimeout = dependencies.clearTimeout ?? clearRestartTimer;
    this.#setTimeout = dependencies.setTimeout ?? setRestartTimer;
  }

  pendingRunnerRestart(runnerId: string): DurableRunnerRestartGate {
    return durableRunnerRestartGate(
      this.#options.store.pendingRestartHandoffs(runnerId),
    );
  }

  recover(runnerId?: string, restartId?: string, resetRetry = true): void {
    if (runnerId !== undefined && this.#options.restart.draining()) {
      return;
    }
    if (runnerId !== undefined && this.#recoveries.has(runnerId)) {
      this.#recoveryRescans.add(runnerId);
      return;
    }
    if (runnerId !== undefined) {
      const pending = this.#options.store.pendingRestartHandoffs(runnerId);
      const gate = pendingRestartGate(pending);
      if (
        gate.status === "conflicted" ||
        (gate.status === "pending" &&
          gate.requestedBy === "runner" &&
          gate.restartId !== restartId)
      ) {
        return;
      }
      if (!this.#recoveringInterrupted.has(runnerId)) {
        this.#options.recoverInterrupted(runnerId);
        this.#recoveringInterrupted.add(runnerId);
      }
    }
    if (runnerId !== undefined && resetRetry) {
      this.#resetRetry(runnerId);
    }
    this.#options.restart.recover((selectedRunnerId) => {
      const runnerIds =
        selectedRunnerId === undefined
          ? new Set([
              ...this.#options.store
                .pendingRestartHandoffs()
                .map(({ detail }) => detail.runnerId),
              ...this.#options.store
                .invalidRestartHandoffs()
                .map(({ runnerId: invalidRunnerId }) => invalidRunnerId),
            ])
          : [selectedRunnerId];
      for (const selected of runnerIds) {
        if (!this.#recoveries.has(selected)) {
          this.#recover(selected, restartId);
        }
      }
    }, runnerId);
  }

  #recover(selectedRunnerId: string | undefined, restartId?: string): void {
    const pendingBefore =
      selectedRunnerId === undefined
        ? new Set<string>()
        : pendingRestartHandoffKeys(
            this.#options.store.pendingRestartHandoffs(selectedRunnerId),
          );
    const recovered = recoverSessionRestartHandoffs(
      {
        credential: (userId, selection) =>
          readSessionRestartCredential(
            this.#options.providers,
            userId,
            selection,
          ),
        launch: this.#options.launch,
        notify: this.#options.notify,
        now: this.#options.now,
        ...(restartId === undefined ? {} : { restartId }),
        runnerIsAvailable: (userId, recoveredRunnerId, workspaceId) =>
          this.#options.restart.accepts(recoveredRunnerId) &&
          this.#options.runnerIsAvailable(
            userId,
            recoveredRunnerId,
            workspaceId,
          ),
        store: this.#options.store,
      },
      selectedRunnerId,
    );
    if (selectedRunnerId !== undefined) {
      this.#trackRecovery(
        selectedRunnerId,
        restartId,
        pendingBefore,
        recovered,
      );
    }
  }

  #retryRecovery(runnerId: string, restartId?: string): void {
    this.#recoveryRescans.delete(runnerId);
    this.#scheduleRetry(runnerId, restartId);
  }

  #trackRecovery(
    runnerId: string,
    restartId: string | undefined,
    pendingBefore: ReadonlySet<string>,
    recovered: ReturnType<typeof recoverSessionRestartHandoffs>,
  ): void {
    this.#recoveries.set(runnerId, recovered);
    void recovered.then(
      ({ pendingCredentials, pendingLaunches }) => {
        if (this.#finishRecovery(runnerId, recovered)) {
          return;
        }
        if (pendingCredentials || pendingLaunches) {
          this.#retryRecovery(runnerId, restartId);
        } else {
          const pendingAfter = pendingRestartHandoffKeys(
            this.#options.store.pendingRestartHandoffs(runnerId),
          );
          const rescanRequested = this.#recoveryRescans.delete(runnerId);
          if (
            !this.#options.restart.draining() &&
            pendingAfter.size > 0 &&
            (rescanRequested ||
              restartHandoffsChanged(pendingBefore, pendingAfter))
          ) {
            this.#recover(runnerId, restartId);
          } else {
            this.#resetRetry(runnerId);
          }
        }
      },
      () => {
        if (!this.#finishRecovery(runnerId, recovered)) {
          this.#retryRecovery(runnerId, restartId);
        }
      },
    );
  }

  restoreDurableRunnerGates(): void {
    if (this.#options.restart.draining()) {
      return;
    }
    const pendingByRunner = new Map<string, PendingRestartSession[]>();
    for (const pending of this.#options.store.pendingRestartHandoffs()) {
      const runnerPending = pendingByRunner.get(pending.detail.runnerId) ?? [];
      runnerPending.push(pending);
      pendingByRunner.set(pending.detail.runnerId, runnerPending);
    }
    for (const [runnerId, pending] of pendingByRunner) {
      const gate = pendingRestartGate(pending);
      if (gate.status === "conflicted") {
        this.#options.restart.blockRunner(runnerId);
      } else if (
        gate.status === "pending" &&
        gate.requestedBy === "runner" &&
        !this.#options.restart.restoreRunner(runnerId, gate.restartId)
      ) {
        this.#options.restart.blockRunner(runnerId);
      }
    }
  }

  resumeRunner(runnerId: string, restartId: string): boolean {
    const gate = this.pendingRunnerRestart(runnerId);
    if (
      gate.status !== "pending" ||
      gate.requestedBy !== "runner" ||
      gate.restartId !== restartId
    ) {
      return false;
    }
    if (!this.#options.restart.accepts(runnerId)) {
      return releaseRunnerForRecovery(
        this.#options.restart,
        runnerId,
        restartId,
      );
    }
    return true;
  }

  #clearRetry(runnerId: string): void {
    const timer = this.#retryTimers.get(runnerId);
    if (timer !== undefined) {
      this.#clearTimeout(timer);
      this.#retryTimers.delete(runnerId);
    }
  }

  #resetRetry(runnerId: string): void {
    this.#clearRetry(runnerId);
    this.#attempts.delete(runnerId);
  }

  #finishRecovery(runnerId: string, recovery: Promise<unknown>): boolean {
    this.#recoveringInterrupted.delete(runnerId);
    if (this.#recoveries.get(runnerId) !== recovery) {
      return true;
    }
    this.#recoveries.delete(runnerId);
    return false;
  }

  #scheduleRetry(runnerId: string, restartId?: string): void {
    if (this.#retryTimers.has(runnerId)) {
      return;
    }
    const attempt = this.#attempts.get(runnerId) ?? 0;
    const delay = Math.min(
      CREDENTIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt, 6),
      CREDENTIAL_RETRY_MAX_DELAY_MS,
    );
    this.#attempts.set(runnerId, attempt + 1);
    const timer = this.#setTimeout(() => {
      this.#clearRetry(runnerId);
      this.recover(runnerId, restartId, false);
    }, delay);
    this.#retryTimers.set(runnerId, timer);
  }
}
