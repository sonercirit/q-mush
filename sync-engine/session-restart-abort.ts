/**
 * Owns the restart abort signal handed to model discovery, provider listing,
 * agent actions and launches. A rejected development restart keeps serving
 * traffic, so the signal must be replaceable: an aborted AbortController can
 * never be reopened.
 */
export class SessionRestartAbort {
  #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason: unknown): void {
    this.#controller.abort(reason);
  }

  restore(): void {
    if (this.#controller.signal.aborted) {
      this.#controller = new AbortController();
    }
  }
}
