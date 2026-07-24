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

  active(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  abort(sessionId: string): void {
    this.#active.get(sessionId)?.controller.abort();
  }

  settled(sessionId: string): Promise<void> {
    return this.#active.get(sessionId)?.settled ?? Promise.resolve();
  }

  async drain(): Promise<void> {
    this.#draining = true;
    await Promise.allSettled(
      [...this.#active.values()].map(({ settled }) => settled),
    );
  }

  launch(sessionId: string, run: SessionRuntime): boolean {
    if (this.#draining) {
      return false;
    }
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
    return true;
  }
}
