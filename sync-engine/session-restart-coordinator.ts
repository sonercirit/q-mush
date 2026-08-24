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

export interface SessionRestartCoordinator {
  readonly pendingRunnerRestart: (runnerId: string) => DurableRunnerRestartGate;
  readonly recover: (
    runnerId?: string,
    restartId?: string,
    resetRetry?: boolean,
  ) => void;
  readonly restoreDurableRunnerGates: () => void;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
}

export function createSessionRestartCoordinator(
  options: SessionRestartCoordinatorOptions,
  dependencies: SessionRestartCoordinatorDependencies = {},
): SessionRestartCoordinator {
  const attempts = new Map<string, number>();
  const clearTimeout = dependencies.clearTimeout ?? clearRestartTimer;
  const recoveries = new Map<string, Promise<unknown>>();
  const recoveryRescans = new Set<string>();
  const recoveringInterrupted = new Set<string>();
  const pendingRestartIds = new Map<string, string>();
  const setTimeout = dependencies.setTimeout ?? setRestartTimer;
  const retryTimers = new Map<string, RestartTimer>();

  function pendingRunnerRestart(runnerId: string): DurableRunnerRestartGate {
    return durableRunnerRestartGate(
      options.store.pendingRestartHandoffs(runnerId),
    );
  }

  function recover(
    runnerId?: string,
    restartId?: string,
    shouldResetRetry = true,
  ): void {
    if (runnerId !== undefined && options.restart.draining()) {
      return;
    }
    if (runnerId !== undefined) {
      const pending = options.store.pendingRestartHandoffs(runnerId);
      const gate = pendingRestartGate(pending);
      if (
        gate.status === "conflicted" ||
        (gate.status === "pending" &&
          gate.requestedBy === "runner" &&
          gate.restartId !== restartId)
      ) {
        return;
      }
      if (recoveries.has(runnerId)) {
        if (restartId !== undefined) {
          pendingRestartIds.set(runnerId, restartId);
        }
        recoveryRescans.add(runnerId);
        return;
      }
      if (!recoveringInterrupted.has(runnerId)) {
        options.recoverInterrupted(runnerId);
        recoveringInterrupted.add(runnerId);
      }
    }
    if (runnerId !== undefined && shouldResetRetry) {
      resetRetry(runnerId);
    }
    options.restart.recover((selectedRunnerId) => {
      const runnerIds =
        selectedRunnerId === undefined
          ? new Set([
              ...options.store
                .pendingRestartHandoffs()
                .map(({ detail }) => detail.runnerId),
              ...options.store
                .invalidRestartHandoffs()
                .map(({ runnerId: invalidRunnerId }) => invalidRunnerId),
            ])
          : [selectedRunnerId];
      for (const selected of runnerIds) {
        if (!recoveries.has(selected)) {
          recoverSelected(selected, restartId);
        }
      }
    }, runnerId);
  }

  function recoverSelected(
    selectedRunnerId: string | undefined,
    restartId?: string,
  ): void {
    const pendingBefore =
      selectedRunnerId === undefined
        ? new Set<string>()
        : pendingRestartHandoffKeys(
            options.store.pendingRestartHandoffs(selectedRunnerId),
          );
    const recovered = recoverSessionRestartHandoffs(
      {
        credential: (userId, selection) =>
          readSessionRestartCredential(options.providers, userId, selection),
        launch: options.launch,
        notify: options.notify,
        now: options.now,
        ...(restartId === undefined ? {} : { restartId }),
        runnerIsAvailable: (userId, recoveredRunnerId, workspaceId) =>
          options.restart.accepts(recoveredRunnerId) &&
          options.runnerIsAvailable(userId, recoveredRunnerId, workspaceId),
        store: options.store,
      },
      selectedRunnerId,
    );
    if (selectedRunnerId !== undefined) {
      trackRecovery(selectedRunnerId, restartId, pendingBefore, recovered);
    }
  }

  function retryRecovery(runnerId: string, restartId?: string): void {
    recoveryRescans.delete(runnerId);
    scheduleRetry(runnerId, restartId);
  }

  function takeRestartId(
    runnerId: string,
    fallback?: string,
  ): string | undefined {
    const restartId = pendingRestartIds.get(runnerId) ?? fallback;
    pendingRestartIds.delete(runnerId);
    return restartId;
  }

  function trackRecovery(
    runnerId: string,
    restartId: string | undefined,
    pendingBefore: ReadonlySet<string>,
    recovered: ReturnType<typeof recoverSessionRestartHandoffs>,
  ): void {
    recoveries.set(runnerId, recovered);
    void recovered.then(
      ({ pendingCredentials, pendingLaunches }) => {
        if (finishRecovery(runnerId, recovered)) {
          return;
        }
        const nextRestartId = takeRestartId(runnerId, restartId);
        if (pendingCredentials || pendingLaunches) {
          retryRecovery(runnerId, nextRestartId);
        } else {
          const pendingAfter = pendingRestartHandoffKeys(
            options.store.pendingRestartHandoffs(runnerId),
          );
          const rescanRequested = recoveryRescans.delete(runnerId);
          if (
            !options.restart.draining() &&
            pendingAfter.size > 0 &&
            (rescanRequested ||
              restartHandoffsChanged(pendingBefore, pendingAfter))
          ) {
            recover(runnerId, nextRestartId);
          } else {
            resetRetry(runnerId);
          }
        }
      },
      () => {
        if (!finishRecovery(runnerId, recovered)) {
          retryRecovery(runnerId, takeRestartId(runnerId, restartId));
        }
      },
    );
  }

  function restoreDurableRunnerGates(): void {
    if (options.restart.draining()) {
      return;
    }
    const pendingByRunner = new Map<string, PendingRestartSession[]>();
    for (const pending of options.store.pendingRestartHandoffs()) {
      const runnerPending = pendingByRunner.get(pending.detail.runnerId) ?? [];
      runnerPending.push(pending);
      pendingByRunner.set(pending.detail.runnerId, runnerPending);
    }
    for (const [runnerId, pending] of pendingByRunner) {
      const gate = pendingRestartGate(pending);
      if (gate.status === "conflicted") {
        options.restart.blockRunner(runnerId);
      } else if (
        gate.status === "pending" &&
        gate.requestedBy === "runner" &&
        !options.restart.restoreRunner(runnerId, gate.restartId)
      ) {
        options.restart.blockRunner(runnerId);
      }
    }
  }

  function resumeRunner(runnerId: string, restartId: string): boolean {
    const gate = pendingRunnerRestart(runnerId);
    if (
      gate.status !== "pending" ||
      gate.requestedBy !== "runner" ||
      gate.restartId !== restartId
    ) {
      return false;
    }
    if (!options.restart.accepts(runnerId)) {
      return releaseRunnerForRecovery(options.restart, runnerId, restartId);
    }
    return true;
  }

  function clearRetry(runnerId: string): void {
    const timer = retryTimers.get(runnerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.delete(runnerId);
    }
  }

  function resetRetry(runnerId: string): void {
    clearRetry(runnerId);
    attempts.delete(runnerId);
  }

  function finishRecovery(
    runnerId: string,
    recovery: Promise<unknown>,
  ): boolean {
    recoveringInterrupted.delete(runnerId);
    if (recoveries.get(runnerId) !== recovery) {
      return true;
    }
    recoveries.delete(runnerId);
    return false;
  }

  function scheduleRetry(runnerId: string, restartId?: string): void {
    if (retryTimers.has(runnerId)) {
      return;
    }
    const attempt = attempts.get(runnerId) ?? 0;
    const delay = Math.min(
      CREDENTIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt, 6),
      CREDENTIAL_RETRY_MAX_DELAY_MS,
    );
    attempts.set(runnerId, attempt + 1);
    const timer = setTimeout(
      () => {
        clearRetry(runnerId);
        recover(runnerId, restartId, false);
      },
      delay,
      { kind: "credential_retry", runnerId },
    );
    retryTimers.set(runnerId, timer);
  }
  return {
    pendingRunnerRestart,
    recover,
    restoreDurableRunnerGates,
    resumeRunner,
  };
}
