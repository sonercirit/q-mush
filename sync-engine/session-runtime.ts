interface ActiveSessionRuntime {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

interface ScheduledSessionRuntime {
  readonly run: SessionRuntime;
}

type SessionRuntime = (controller: AbortController) => Promise<void>;

export class SessionRuntimes {
  readonly #active = new Map<string, ActiveSessionRuntime>();
  readonly #scheduled = new Map<string, ScheduledSessionRuntime>();
  #draining = false;

  get draining(): boolean {
    return this.#draining;
  }

  active(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  abort(sessionId: string): void {
    this.#scheduled.delete(sessionId);
    this.#active.get(sessionId)?.controller.abort();
  }

  async drain(): Promise<void> {
    this.#draining = true;
    this.#scheduled.clear();
    await Promise.allSettled(
      [...this.#active.values()].map(({ settled }) => settled),
    );
  }

  // cpd-ignore-start -- Immediate and deferred launches share the same runtime admission guard.
  launch(sessionId: string, run: SessionRuntime): boolean {
    if (this.#draining || this.#active.has(sessionId)) {
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

  schedule(sessionId: string, run: SessionRuntime): boolean {
    if (this.#draining || this.#scheduled.has(sessionId)) {
      return false;
    }
    if (!this.#active.has(sessionId)) {
      return this.launch(sessionId, run);
    }
    this.#scheduled.set(sessionId, { run });
    void this.#launchAfterActive(sessionId, run);
    return true;
  }

  async #launchAfterActive(
    sessionId: string,
    run: SessionRuntime,
  ): Promise<void> {
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      await active.settled.catch(() => undefined);
    }
    const scheduled = this.#scheduled.get(sessionId);
    if (this.#draining || scheduled?.run !== run) {
      this.#scheduled.delete(sessionId);
      return;
    }
    this.#scheduled.delete(sessionId);
    this.launch(sessionId, run);
  }
  // cpd-ignore-end
}
