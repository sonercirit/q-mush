import type { RestartHandoffRequester } from "../shared/session-model.ts";

export type RestartScope =
  | { readonly kind: "server" }
  | { readonly kind: "runner"; readonly runnerId: string };

export interface RestartRequest {
  readonly requestedBy: RestartHandoffRequester;
  readonly restartId: string;
}

interface ActiveSessionRuntime {
  readonly controller: AbortController;
  restartRequest: RestartRequest | undefined;
  readonly runnerId: string;
  settled: Promise<void>;
}

interface SessionRuntimeContext {
  readonly controller: AbortController;
  readonly restartRequest: () => RestartRequest | undefined;
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
    requestedBy: scope.kind === "server" ? "server" : "runner",
    restartId,
  };
}

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  readonly #drainingRunners = new Map<string, RestartRequest>();
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

  accepts(runnerId: string): boolean {
    return (
      this.#drainingServer === undefined && !this.#drainingRunners.has(runnerId)
    );
  }

  drainRequest(scope: RestartScope): RestartRequest | undefined {
    return scope.kind === "server"
      ? this.#drainingServer
      : this.#drainingRunners.get(scope.runnerId);
  }

  pendingRestart(runnerId: string): RestartRequest | undefined {
    return this.#drainingServer ?? this.#drainingRunners.get(runnerId);
  }

  async drain(scope: RestartScope, restartId: string): Promise<void> {
    if (restartId.length === 0 || restartId.length > 200) {
      throw new Error("The restart ID is invalid");
    }
    const existing = this.drainRequest(scope);
    if (existing !== undefined && existing.restartId !== restartId) {
      throw new Error("A different restart is already draining this scope");
    }
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
      runtime.restartRequest ??= request;
    }
    await Promise.all(affected.map(({ settled }) => settled));
  }

  launch(sessionId: string, runnerId: string, run: SessionRuntime): boolean {
    if (!this.accepts(runnerId) || this.#active.has(sessionId)) {
      return false;
    }
    const controller = new AbortController();
    const runtime: ActiveSessionRuntime = {
      controller,
      restartRequest: undefined,
      runnerId,
      settled: Promise.resolve(),
    };
    runtime.settled = Promise.resolve().then(() =>
      run({
        controller,
        restartRequest: () => runtime.restartRequest,
      }),
    );
    const clear = () => {
      if (this.#active.get(sessionId) === runtime) {
        this.#active.delete(sessionId);
      }
    };
    this.#active.set(sessionId, runtime);
    void runtime.settled.then(clear, clear);
    return true;
  }

  runnerConnected(runnerId: string): void {
    this.#drainingRunners.delete(runnerId);
  }

  serverStarted(): void {
    this.#drainingServer = undefined;
  }
}
