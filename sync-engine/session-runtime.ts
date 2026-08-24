import type {
  RestartHandoffRequester,
  SessionRuntimePending,
  SessionRuntimePendingComponent,
} from "../shared/session-model.ts";
import type {
  RestartRequestPersistence,
  SessionRestartRequester,
} from "./session-restart-requester.ts";

export type RestartScope =
  | { readonly kind: "server" }
  | { readonly kind: "runner"; readonly runnerId: string };

export type RestartBoundary = "handoff" | "step";

export interface RestartRequest {
  readonly boundary: RestartBoundary;
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

export interface RestartDrainProgress {
  readonly elapsedMs: number;
  readonly runnerId: string;
  readonly sessionId: string;
}

export interface RestartDrainSettlement {
  readonly persistence: Promise<unknown>;
  readonly settled: Promise<unknown>;
}

const BLOCKED_RUNNER_RESTART = Symbol("blocked runner restart");
type RunnerRestartGate = RestartRequest | typeof BLOCKED_RUNNER_RESTART;

interface PendingRestartPersistence {
  readonly durable: boolean;
  readonly forcePark: boolean;
  readonly promise: Promise<void>;
}

interface ActiveSessionRuntime {
  readonly boundary: RestartBoundary;
  readonly controller: AbortController;
  readonly generation: number;
  pending: SessionRuntimePending;
  restartRequestedAt: number | undefined;
  persistRestart: RestartRequestPersistence | undefined;
  pendingPersistence: PendingRestartPersistence[];
  forceParked: boolean;
  restartDurable: boolean;
  restartRequest: RestartRequest | undefined;
  clearDurable: (() => Promise<void> | void) | undefined;
  readonly runnerId: string;
  settled: Promise<void>;
}

interface SessionRuntimeContext extends SessionRestartRequester {
  readonly controller: AbortController;
  readonly pendingComponent: (
    component: SessionRuntimePendingComponent,
  ) => boolean;
  readonly settled: (clearDurable: () => Promise<void> | void) => void;
}

type SessionRuntime = (context: SessionRuntimeContext) => Promise<void>;

interface RestartRequestOutcome {
  readonly affected: readonly ActiveSessionRuntime[];
  readonly persistence: Promise<void>;
}

function trackRestartPersistence(
  runtime: ActiveSessionRuntime,
  result: Promise<void> | void,
  durable: boolean,
  forcePark: boolean,
): Promise<void> | undefined {
  if (result === undefined) return undefined;
  const pending = { durable, forcePark, promise: Promise.resolve(result) };
  runtime.pendingPersistence.push(pending);
  const settled = () => {
    const index = runtime.pendingPersistence.indexOf(pending);
    if (index >= 0) runtime.pendingPersistence.splice(index, 1);
  };
  void pending.promise.then(settled, settled);
  return pending.promise;
}

function scopeIncludes(scope: RestartScope, runnerId: string): boolean {
  return scope.kind === "server" || scope.runnerId === runnerId;
}

function restartRequest(
  scope: RestartScope,
  restartId: string,
): RestartRequest {
  return {
    boundary: scope.kind === "server" ? "step" : "handoff",
    requestedBy: scope.kind === "server" ? "server" : "runner",
    restartId,
  };
}

function assertRestartId(restartId: string): void {
  if (!isValidRestartId(restartId)) {
    throw new Error("The restart ID is invalid");
  }
}

function assertCompatibleRestart(
  existing: RunnerRestartGate | undefined,
  restartId: string,
): asserts existing is RestartRequest | undefined {
  if (
    existing !== undefined &&
    (existing === BLOCKED_RUNNER_RESTART || existing.restartId !== restartId)
  ) {
    throw new Error("A different restart is already draining this scope");
  }
}

export function isValidRestartId(restartId: string): boolean {
  return restartId.trim().length > 0 && restartId.length <= 200;
}

function applyRequest(
  scope: RestartScope,
  request: RestartRequest,
  server: (request: RestartRequest) => void,
  runner: (runnerId: string, request: RestartRequest) => void,
): void {
  if (scope.kind === "server") server(request);
  else runner(scope.runnerId, request);
}

export interface SessionRuntimes {
  readonly draining: boolean;
  drainProgress(scope?: RestartScope): readonly RestartDrainProgress[];
  forcePark(scope: RestartScope, initialPersistence?: Promise<unknown>): Promise<readonly string[]>;
  active(sessionId: string): boolean; activeForGeneration(sessionId: string, generation: number): boolean;
  pending(sessionId: string, generation: number): SessionRuntimePending | undefined; abort(sessionId: string): void;
  activeGenerationMatches(sessionId: string, generation: number): boolean; abortForGeneration(sessionId: string, generation: number, reason?: DOMException): boolean;
  settled(sessionId: string): Promise<void>; cleared(sessionId: string): Promise<void>; accepts(runnerId: string): boolean;
  drainRequest(scope: RestartScope): RestartRequest | undefined; pendingRestart(runnerId: string): RestartRequest | undefined;
  mark(scope: RestartScope, restartId: string): Promise<void>; requestDrain(scope: RestartScope, restartId: string, durable: boolean): RestartDrainSettlement; drain(scope: RestartScope, restartId: string): Promise<void>;
  launch(sessionId: string, runnerId: string, generationOrRun: number | SessionRuntime, boundaryOrRun?: RestartBoundary | SessionRuntime, maybeRun?: SessionRuntime): boolean;
  resumeRunner(runnerId: string, restartId: string): boolean; blockRunner(runnerId: string): void; restoreRunner(runnerId: string, restartId: string): boolean; start(runnerId?: string): void;
}

export function createSessionRuntimes(now: () => number = Date.now): SessionRuntimes {
  const activeRuntimes = new Map<string, ActiveSessionRuntime>();
  const drainingRunners = new Map<string, RunnerRestartGate>();
  let drainingServer: RestartRequest | undefined;
  const requestRestart = (scope: RestartScope, restartId: string, durable: boolean): RestartRequestOutcome => {
    assertRestartId(restartId);
    const existing = scope.kind === "server" ? drainingServer : drainingRunners.get(scope.runnerId);
    assertCompatibleRestart(existing, restartId);
    const request = existing ?? restartRequest(scope, restartId);
    if (existing === undefined) applyRequest(scope, request, (value) => { drainingServer = value; }, (runnerId, value) => { drainingRunners.set(runnerId, value); });
    const affected = [...activeRuntimes.values()].filter(({ runnerId }) => scopeIncludes(scope, runnerId));
    for (const runtime of affected) {
      const scopedRequest = { ...request, boundary: runtime.boundary };
      if (runtime.restartRequest === undefined || (durable && scope.kind === "server" && runtime.restartRequest.requestedBy === "runner")) runtime.restartRequest = scopedRequest;
      runtime.restartRequestedAt ??= now();
      runtime.restartDurable ||= durable;
    }
    const persistence = affected.flatMap((runtime) => {
      const pending = trackRestartPersistence(runtime, runtime.persistRestart?.(runtime.restartRequest ?? request, runtime.restartDurable), runtime.restartDurable, false);
      return pending === undefined ? [] : [pending];
    });
    return { affected, persistence: Promise.all(persistence).then(() => undefined) };
  };
  const runtimes: SessionRuntimes = {

  get draining() {
    return drainingServer !== undefined;
  },

  // Sessions still holding a requested restart open, longest wait first, so a
  // drain can report exactly what it waits on.
  drainProgress(scope?: RestartScope): readonly RestartDrainProgress[] {
    const currentTime = now();
    return [...activeRuntimes]
      .flatMap(([sessionId, runtime]) =>
        runtime.restartRequestedAt === undefined ||
        (scope !== undefined && !scopeIncludes(scope, runtime.runnerId))
          ? []
          : [
              {
                elapsedMs: currentTime - runtime.restartRequestedAt,
                runnerId: runtime.runnerId,
                sessionId,
              },
            ],
      )
      .sort((first, second) => second.elapsedMs - first.elapsedMs);
  },

  // Force-parks the runtimes a drain still waits on. Persistence is invoked
  // immediately beforehand with the force-park flag so a runner-scoped drain
  // can keep its normal boundary semantics but still become crash-durable.
  async forcePark(
    scope: RestartScope,
    initialPersistence: Promise<unknown> = Promise.resolve(),
  ): Promise<readonly string[]> {
    const candidates = [...activeRuntimes.entries()].filter(
      ([, runtime]) =>
        runtime.restartRequest !== undefined &&
        !runtime.forceParked &&
        scopeIncludes(scope, runtime.runnerId),
    );
    const persistence: Promise<void>[] = [];
    for (const [, runtime] of candidates) {
      const request = runtime.restartRequest;
      if (request !== undefined) {
        const needsForceParkPersistence =
          !runtime.restartDurable ||
          runtime.pendingPersistence.some(
            ({ durable, forcePark }) => durable && !forcePark,
          );
        runtime.restartDurable = true;
        const persisted = !needsForceParkPersistence
          ? undefined
          : (runtime.pendingPersistence.find(({ forcePark }) => forcePark)
              ?.promise ??
            trackRestartPersistence(
              runtime,
              runtime.persistRestart?.(request, true, true),
              true,
              true,
            ));
        if (persisted !== undefined) persistence.push(persisted);
      }
    }
    await Promise.all([initialPersistence, ...persistence]);
    const parked: string[] = [];
    for (const [sessionId, runtime] of candidates) {
      if (runtime.restartRequest === undefined) continue;
      parked.push(sessionId);
      runtime.forceParked = true;
      // The durable handoff now owns the session's resumption, so it stops
      // counting as pending drain work even while its runtime unwinds.
      runtime.restartRequestedAt = undefined;
      runtime.controller.abort(
        new DOMException(
          "The restart drain reached its limit",
          "RestartHandoff",
        ),
      );
    }
    return parked;
  },

  active(sessionId: string): boolean {
    return activeRuntimes.has(sessionId);
  },

  activeForGeneration(sessionId: string, generation: number): boolean {
    return runtimes.activeGenerationMatches(sessionId, generation);
  },

  pending(
    sessionId: string,
    generation: number,
  ): SessionRuntimePending | undefined {
    const runtime = activeRuntimes.get(sessionId);
    return runtime?.generation === generation ? runtime.pending : undefined;
  },

  abort(sessionId: string): void {
    activeRuntimes.get(sessionId)?.controller.abort();
  },

  activeGenerationMatches(sessionId: string, generation: number): boolean {
    return activeRuntimes.get(sessionId)?.generation === generation;
  },

  abortForGeneration(
    sessionId: string,
    generation: number,
    reason: DOMException = new DOMException(
      "The session tools changed",
      "AbortError",
    ),
  ): boolean {
    if (!runtimes.activeGenerationMatches(sessionId, generation)) {
      return false;
    }
    activeRuntimes.get(sessionId)?.controller.abort(reason);
    return true;
  },

  settled(sessionId: string): Promise<void> {
    return activeRuntimes.get(sessionId)?.settled ?? Promise.resolve();
  },

  cleared(sessionId: string): Promise<void> {
    const runtime = activeRuntimes.get(sessionId);
    return runtime === undefined
      ? Promise.resolve()
      : runtime.settled.then(
          () => runtimes.cleared(sessionId),
          () => runtimes.cleared(sessionId),
        );
  },

  accepts(runnerId: string): boolean {
    return (
      drainingServer === undefined && !drainingRunners.has(runnerId)
    );
  },

  drainRequest(scope: RestartScope): RestartRequest | undefined {
    if (scope.kind === "server") {
      return drainingServer;
    }
    const gate = drainingRunners.get(scope.runnerId);
    return gate === BLOCKED_RUNNER_RESTART ? undefined : gate;
  },

  pendingRestart(runnerId: string): RestartRequest | undefined {
    const runnerGate = drainingRunners.get(runnerId);
    return (
      drainingServer ??
      (runnerGate === BLOCKED_RUNNER_RESTART ? undefined : runnerGate)
    );
  },

  mark(scope: RestartScope, restartId: string): Promise<void> {
    const outcome = requestRestart(scope, restartId, true);
    return outcome.persistence;
  },

  // Requests the drain and hands back the settlement wait so callers can bound
  // it; the request itself, including durable persistence, always completes.
  // The wait is wrapped because awaiting a returned promise would flatten it
  // and reintroduce the unbounded wait.
  requestDrain(
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ): RestartDrainSettlement {
    const { affected, persistence } = requestRestart(scope, restartId, durable);
    return {
      persistence,
      settled: persistence.then(() =>
        Promise.allSettled(affected.map(({ settled }) => settled)),
      ),
    };
  },

  async drain(scope: RestartScope, restartId: string): Promise<void> {
    const { settled } = runtimes.requestDrain(scope, restartId, false);
    await settled;
  },

  launch(
    sessionId: string,
    runnerId: string,
    generationOrRun: number | SessionRuntime,
    boundaryOrRun?: RestartBoundary | SessionRuntime,
    maybeRun?: SessionRuntime,
  ): boolean {
    const generation =
      typeof generationOrRun === "number" ? generationOrRun : 0;
    const boundary =
      typeof boundaryOrRun === "string" ? boundaryOrRun : "handoff";
    const run =
      typeof generationOrRun === "number"
        ? typeof boundaryOrRun === "function"
          ? boundaryOrRun
          : maybeRun
        : generationOrRun;
    if (
      run === undefined ||
      !runtimes.accepts(runnerId) ||
      activeRuntimes.has(sessionId)
    ) {
      return false;
    }
    const controller = new AbortController();
    const runtime: ActiveSessionRuntime = {
      boundary,
      controller,
      forceParked: false,
      generation,
      pendingPersistence: [],
      pending: { component: "startup", since: now() },
      persistRestart: undefined,
      restartDurable: false,
      restartRequest: undefined,
      restartRequestedAt: undefined,
      clearDurable: undefined,
      runnerId,
      settled: Promise.resolve(),
    };
    activeRuntimes.set(sessionId, runtime);
    try {
      runtime.settled = Promise.resolve(
        run({
          controller,
          pendingComponent: (component) => {
            if (activeRuntimes.get(sessionId) !== runtime) {
              return false;
            }
            const unchanged = runtime.pending.component === component;
            if (unchanged && component !== "provider_admission") {
              return false;
            }
            runtime.pending = { component, since: now() };
            return true;
          },
          restartRequest: (persist) => {
            if (persist !== undefined) {
              runtime.persistRestart = persist;
              if (runtime.restartRequest !== undefined) {
                void trackRestartPersistence(
                  runtime,
                  persist(runtime.restartRequest, runtime.restartDurable),
                  runtime.restartDurable,
                  false,
                );
              }
            }
            return runtime.restartRequest;
          },
          settled: (clearDurable) => {
            runtime.clearDurable = clearDurable;
          },
        }),
      );
    } catch (error) {
      runtime.settled = Promise.reject(
        error instanceof Error
          ? error
          : new Error("The session runtime failed"),
      );
    }
    const clear = () => {
      // A force-parked runtime never reached its own handoff boundary, so its
      // durable marker is the only record that the session must resume.
      if (runtime.restartDurable && !runtime.forceParked) {
        void runtime.clearDurable?.();
      }
      if (activeRuntimes.get(sessionId) === runtime) {
        activeRuntimes.delete(sessionId);
      }
    };
    void runtime.settled.then(clear, clear);
    return true;
  },

  resumeRunner(runnerId: string, restartId: string): boolean {
    const restart = drainingRunners.get(runnerId);
    if (
      drainingServer !== undefined ||
      restart === BLOCKED_RUNNER_RESTART ||
      restart?.restartId !== restartId
    ) {
      return false;
    }
    for (const runtime of activeRuntimes.values()) {
      if (
        runtime.runnerId === runnerId &&
        runtime.restartRequest?.restartId === restartId
      ) {
        runtime.restartRequest = undefined;
        runtime.restartRequestedAt = undefined;
      }
    }
    drainingRunners.delete(runnerId);
    return true;
  },

  blockRunner(runnerId: string): void {
    if (drainingServer === undefined) {
      drainingRunners.set(runnerId, BLOCKED_RUNNER_RESTART);
    }
  },

  restoreRunner(runnerId: string, restartId: string): boolean {
    assertRestartId(restartId);
    if (drainingServer !== undefined) {
      return false;
    }
    const existing = drainingRunners.get(runnerId);
    assertCompatibleRestart(existing, restartId);
    drainingRunners.set(
      runnerId,
      existing ?? restartRequest({ kind: "runner", runnerId }, restartId),
    );
    return true;
  },

  start(runnerId?: string): void {
    if (runnerId === undefined) {
      const abandoned = drainingServer;
      drainingServer = undefined;
      if (abandoned === undefined) return;
      for (const runtime of activeRuntimes.values()) {
        if (
          runtime.restartRequest?.requestedBy !== "server" ||
          runtime.restartRequest.restartId !== abandoned.restartId
        ) {
          continue;
        }
        // A runner drain the server request had taken authority over is still
        // gating this runner, so the session stays its pending work instead of
        // vanishing from that drain's progress and force-park candidates.
        const runnerGate = drainingRunners.get(runtime.runnerId);
        if (runnerGate !== undefined && runnerGate !== BLOCKED_RUNNER_RESTART) {
          runtime.restartRequest = {
            ...runnerGate,
            boundary: runtime.boundary,
          };
          // The runner request already started this session's clock before the
          // server drain took authority. Preserve that honest elapsed time;
          // force-parked sessions have no clock and stay out of progress.
          continue;
        }
        runtime.restartRequest = undefined;
        runtime.restartRequestedAt = undefined;
      }
      return;
    }
    drainingRunners.delete(runnerId);
  }  };
  return runtimes;
}
