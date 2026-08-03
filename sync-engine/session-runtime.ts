import type { RestartHandoffRequester } from "../shared/session-model.ts";
import type { SessionRestartRequester } from "./session-restart-requester.ts";

export type RestartScope =
  | { readonly kind: "server" }
  | { readonly kind: "runner"; readonly runnerId: string };

export type RestartBoundary = "handoff" | "step";

export interface RestartRequest {
  readonly boundary: RestartBoundary;
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

const BLOCKED_RUNNER_RESTART = Symbol("blocked runner restart");
type RunnerRestartGate = RestartRequest | typeof BLOCKED_RUNNER_RESTART;

interface ActiveSessionRuntime {
  readonly boundary: RestartBoundary;
  readonly controller: AbortController;
  readonly generation: number;
  persistRestart:
    | ((request: RestartRequest, durable: boolean) => Promise<void> | void)
    | undefined;
  restartDurable: boolean;
  restartRequest: RestartRequest | undefined;
  clearDurable: (() => Promise<void> | void) | undefined;
  readonly runnerId: string;
  settled: Promise<void>;
}

interface SessionRuntimeContext extends SessionRestartRequester {
  readonly controller: AbortController;
  readonly settled: (clearDurable: () => Promise<void> | void) => void;
}

type SessionRuntime = (context: SessionRuntimeContext) => Promise<void>;

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

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  readonly #drainingRunners = new Map<string, RunnerRestartGate>();
  #drainingServer: RestartRequest | undefined;

  get draining(): boolean {
    return this.#drainingServer !== undefined;
  }

  active(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  abort(sessionId: string): void {
    this.#active.get(sessionId)?.controller.abort();
  }

  activeGenerationMatches(sessionId: string, generation: number): boolean {
    return this.#active.get(sessionId)?.generation === generation;
  }

  abortForGeneration(sessionId: string, generation: number): boolean {
    if (!this.activeGenerationMatches(sessionId, generation)) {
      return false;
    }
    this.#active
      .get(sessionId)
      ?.controller.abort(
        new DOMException("The session tools changed", "AbortError"),
      );
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

  async #request(
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ): Promise<readonly ActiveSessionRuntime[]> {
    assertRestartId(restartId);
    const existing =
      scope.kind === "server"
        ? this.#drainingServer
        : this.#drainingRunners.get(scope.runnerId);
    assertCompatibleRestart(existing, restartId);
    const request = existing ?? restartRequest(scope, restartId);
    if (existing === undefined) {
      if (scope.kind === "server") {
        this.#drainingServer = request;
      } else {
        this.#drainingRunners.set(scope.runnerId, request);
      }
    }
    const affected = [...this.#active.values()].filter(({ runnerId }) =>
      scopeIncludes(scope, runnerId),
    );
    for (const runtime of affected) {
      runtime.restartRequest ??= {
        ...request,
        boundary: runtime.boundary,
      };
      runtime.restartDurable ||= durable;
    }
    await Promise.all(
      affected.flatMap((runtime) => {
        const persisted = runtime.persistRestart?.(
          runtime.restartRequest ?? request,
          runtime.restartDurable,
        );
        return persisted === undefined ? [] : [persisted];
      }),
    );
    return affected;
  }

  async mark(scope: RestartScope, restartId: string): Promise<void> {
    await this.#request(scope, restartId, true);
  }

  async drain(scope: RestartScope, restartId: string): Promise<void> {
    const affected = await this.#request(scope, restartId, false);
    await Promise.allSettled(affected.map(({ settled }) => settled));
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
      generation,
      persistRestart: undefined,
      restartDurable: false,
      restartRequest: undefined,
      clearDurable: undefined,
      runnerId,
      settled: Promise.resolve(),
    };
    this.#active.set(sessionId, runtime);
    try {
      runtime.settled = Promise.resolve(
        run({
          controller,
          restartRequest: (persist) => {
            if (persist !== undefined) {
              runtime.persistRestart = persist;
              if (runtime.restartRequest !== undefined) {
                void persist(runtime.restartRequest, runtime.restartDurable);
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
      if (runtime.restartDurable) {
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
      this.#drainingServer = undefined;
      return;
    }
    this.#drainingRunners.delete(runnerId);
  }
}
