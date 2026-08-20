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

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  readonly #drainingRunners = new Map<string, RunnerRestartGate>();
  readonly #now: () => number;
  #drainingServer: RestartRequest | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get draining(): boolean {
    return this.#drainingServer !== undefined;
  }

  // Sessions still holding a requested restart open, longest wait first, so a
  // drain can report exactly what it waits on.
  drainProgress(scope?: RestartScope): readonly RestartDrainProgress[] {
    const now = this.#now();
    return [...this.#active]
      .flatMap(([sessionId, runtime]) =>
        runtime.restartRequestedAt === undefined ||
        (scope !== undefined && !scopeIncludes(scope, runtime.runnerId))
          ? []
          : [
              {
                elapsedMs: now - runtime.restartRequestedAt,
                runnerId: runtime.runnerId,
                sessionId,
              },
            ],
      )
      .sort((first, second) => second.elapsedMs - first.elapsedMs);
  }

  // Force-parks the runtimes a drain still waits on. Persistence is invoked
  // immediately beforehand with the force-park flag so a runner-scoped drain
  // can keep its normal boundary semantics but still become crash-durable.
  async forcePark(
    scope: RestartScope,
    initialPersistence: Promise<unknown> = Promise.resolve(),
  ): Promise<readonly string[]> {
    const candidates = [...this.#active.entries()].filter(
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
  }

  active(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  activeForGeneration(sessionId: string, generation: number): boolean {
    return this.activeGenerationMatches(sessionId, generation);
  }

  pending(
    sessionId: string,
    generation: number,
  ): SessionRuntimePending | undefined {
    const runtime = this.#active.get(sessionId);
    return runtime?.generation === generation ? runtime.pending : undefined;
  }

  abort(sessionId: string): void {
    this.#active.get(sessionId)?.controller.abort();
  }

  activeGenerationMatches(sessionId: string, generation: number): boolean {
    return this.#active.get(sessionId)?.generation === generation;
  }

  abortForGeneration(
    sessionId: string,
    generation: number,
    reason: DOMException = new DOMException(
      "The session tools changed",
      "AbortError",
    ),
  ): boolean {
    if (!this.activeGenerationMatches(sessionId, generation)) {
      return false;
    }
    this.#active.get(sessionId)?.controller.abort(reason);
    return true;
  }

  settled(sessionId: string): Promise<void> {
    return this.#active.get(sessionId)?.settled ?? Promise.resolve();
  }

  cleared(sessionId: string): Promise<void> {
    const runtime = this.#active.get(sessionId);
    return runtime === undefined
      ? Promise.resolve()
      : runtime.settled.then(
          () => this.cleared(sessionId),
          () => this.cleared(sessionId),
        );
  }

  accepts(runnerId: string): boolean {
    return (
      this.#drainingServer === undefined && !this.#drainingRunners.has(runnerId)
    );
  }

  drainRequest(scope: RestartScope): RestartRequest | undefined {
    if (scope.kind === "server") {
      return this.#drainingServer;
    }
    const gate = this.#drainingRunners.get(scope.runnerId);
    return gate === BLOCKED_RUNNER_RESTART ? undefined : gate;
  }

  pendingRestart(runnerId: string): RestartRequest | undefined {
    const runnerGate = this.#drainingRunners.get(runnerId);
    return (
      this.#drainingServer ??
      (runnerGate === BLOCKED_RUNNER_RESTART ? undefined : runnerGate)
    );
  }

  #request(
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ): RestartRequestOutcome {
    assertRestartId(restartId);
    const existing =
      scope.kind === "server"
        ? this.#drainingServer
        : this.#drainingRunners.get(scope.runnerId);
    assertCompatibleRestart(existing, restartId);
    const request = existing ?? restartRequest(scope, restartId);
    if (existing === undefined) {
      applyRequest(
        scope,
        request,
        (value) => {
          this.#drainingServer = value;
        },
        (runnerId, value) => {
          this.#drainingRunners.set(runnerId, value);
        },
      );
    }
    const affected = [...this.#active.values()].filter(({ runnerId }) =>
      scopeIncludes(scope, runnerId),
    );
    for (const runtime of affected) {
      const scopedRequest = {
        ...request,
        boundary: runtime.boundary,
      };
      if (
        runtime.restartRequest === undefined ||
        (scope.kind === "server" &&
          runtime.restartRequest.requestedBy === "runner")
      ) {
        runtime.restartRequest = scopedRequest;
      }
      runtime.restartRequestedAt ??= this.#now();
      runtime.restartDurable ||= durable;
    }
    const persistence = affected.flatMap((runtime) => {
      const pending = trackRestartPersistence(
        runtime,
        runtime.persistRestart?.(
          runtime.restartRequest ?? request,
          runtime.restartDurable,
        ),
        runtime.restartDurable,
        false,
      );
      return pending === undefined ? [] : [pending];
    });
    return {
      affected,
      persistence: Promise.all(persistence).then(() => undefined),
    };
  }

  mark(scope: RestartScope, restartId: string): Promise<void> {
    const outcome = this.#request(scope, restartId, true);
    return outcome.persistence;
  }

  // Requests the drain and hands back the settlement wait so callers can bound
  // it; the request itself, including durable persistence, always completes.
  // The wait is wrapped because awaiting a returned promise would flatten it
  // and reintroduce the unbounded wait.
  requestDrain(
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ): RestartDrainSettlement {
    const { affected, persistence } = this.#request(scope, restartId, durable);
    return {
      persistence,
      settled: persistence.then(() =>
        Promise.allSettled(affected.map(({ settled }) => settled)),
      ),
    };
  }

  async drain(scope: RestartScope, restartId: string): Promise<void> {
    const { settled } = this.requestDrain(scope, restartId, false);
    await settled;
  }

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
      !this.accepts(runnerId) ||
      this.#active.has(sessionId)
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
      pending: { component: "startup", since: this.#now() },
      persistRestart: undefined,
      restartDurable: false,
      restartRequest: undefined,
      restartRequestedAt: undefined,
      clearDurable: undefined,
      runnerId,
      settled: Promise.resolve(),
    };
    this.#active.set(sessionId, runtime);
    try {
      runtime.settled = Promise.resolve(
        run({
          controller,
          pendingComponent: (component) => {
            if (this.#active.get(sessionId) !== runtime) {
              return false;
            }
            const unchanged = runtime.pending.component === component;
            if (unchanged && component !== "provider_admission") {
              return false;
            }
            runtime.pending = { component, since: this.#now() };
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
      if (this.#active.get(sessionId) === runtime) {
        this.#active.delete(sessionId);
      }
    };
    void runtime.settled.then(clear, clear);
    return true;
  }

  resumeRunner(runnerId: string, restartId: string): boolean {
    const restart = this.#drainingRunners.get(runnerId);
    if (
      this.#drainingServer !== undefined ||
      restart === BLOCKED_RUNNER_RESTART ||
      restart?.restartId !== restartId
    ) {
      return false;
    }
    for (const runtime of this.#active.values()) {
      if (
        runtime.runnerId === runnerId &&
        runtime.restartRequest?.restartId === restartId
      ) {
        runtime.restartRequest = undefined;
        runtime.restartRequestedAt = undefined;
      }
    }
    this.#drainingRunners.delete(runnerId);
    return true;
  }

  blockRunner(runnerId: string): void {
    if (this.#drainingServer === undefined) {
      this.#drainingRunners.set(runnerId, BLOCKED_RUNNER_RESTART);
    }
  }

  restoreRunner(runnerId: string, restartId: string): boolean {
    assertRestartId(restartId);
    if (this.#drainingServer !== undefined) {
      return false;
    }
    const existing = this.#drainingRunners.get(runnerId);
    assertCompatibleRestart(existing, restartId);
    this.#drainingRunners.set(
      runnerId,
      existing ?? restartRequest({ kind: "runner", runnerId }, restartId),
    );
    return true;
  }

  start(runnerId?: string): void {
    if (runnerId === undefined) {
      const abandoned = this.#drainingServer;
      this.#drainingServer = undefined;
      if (abandoned === undefined) return;
      for (const runtime of this.#active.values()) {
        if (
          runtime.restartRequest?.requestedBy !== "server" ||
          runtime.restartRequest.restartId !== abandoned.restartId
        ) {
          continue;
        }
        // A runner drain the server request had taken authority over is still
        // gating this runner, so the session stays its pending work instead of
        // vanishing from that drain's progress and force-park candidates.
        const runnerGate = this.#drainingRunners.get(runtime.runnerId);
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
    this.#drainingRunners.delete(runnerId);
  }
}
