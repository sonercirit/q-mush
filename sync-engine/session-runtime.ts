interface ActiveSessionRuntime {
  readonly controller: AbortController;
  settled: Promise<void>;
}

type SessionRuntime = (controller: AbortController) => Promise<void>;

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  #draining = false;

  get draining(): boolean {
    return this.#draining;
  }

  active(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  abort(sessionId: string): void {
    this.#active.get(sessionId)?.controller.abort();
  }

  wait(sessionId: string): Promise<void> {
    const runtime = this.#active.get(sessionId);
    return runtime === undefined ? Promise.resolve() : runtime.settled;
  }

  async drain(): Promise<void> {
    this.#draining = true;
    await Promise.allSettled(
      [...this.#active.values()].map(({ settled }) => settled),
    );
  }

  launch(sessionId: string, run: SessionRuntime): boolean {
    if (this.#draining || this.#active.has(sessionId)) {
      return false;
    }
    const controller = new AbortController();
    const runtime: ActiveSessionRuntime = {
      controller,
      settled: Promise.resolve(),
    };
    const clear = () => {
      if (this.#active.get(sessionId) === runtime) {
        this.#active.delete(sessionId);
      }
    };
    const settled = Promise.resolve()
      .then(() => run(controller))
      .then(clear, clear);
    runtime.settled = settled;
    this.#active.set(sessionId, runtime);
    return true;
  }
}
