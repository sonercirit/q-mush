interface ActiveSessionRuntime {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

type SessionRuntime = (controller: AbortController) => Promise<void>;

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  #draining = false;

  get draining(): boolean {
    return this.#draining;
  }

  abort(sessionId: string): void {
    this.#active.get(sessionId)?.controller.abort();
  }

  async drain(): Promise<void> {
    this.#draining = true;
    await Promise.allSettled(
      [...this.#active.values()].map(({ settled }) => settled),
    );
  }

  launch(sessionId: string, run: SessionRuntime): void {
    const controller = new AbortController();
    const settled = Promise.resolve().then(() => run(controller));
    const runtime = { controller, settled };
    const clear = () => {
      if (this.#active.get(sessionId) === runtime) {
        this.#active.delete(sessionId);
      }
    };
    this.#active.set(sessionId, runtime);
    void settled.then(clear, clear);
  }
}
