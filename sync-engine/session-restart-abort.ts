/**
 * Owns the restart abort signal handed to model discovery, provider listing,
 * agent actions and launches. A rejected development restart keeps serving
 * traffic, so the signal must be replaceable: an aborted AbortController can
 * never be reopened.
 */
export interface SessionRestartAbort {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown) => void;
  readonly restore: () => void;
}

export function createSessionRestartAbort(): SessionRestartAbort {
  let controller = new AbortController();
  return {
    get signal() {
      return controller.signal;
    },
    abort: (reason) => {
      controller.abort(reason);
    },
    restore: () => {
      if (controller.signal.aborted) {
        controller = new AbortController();
      }
    },
  };
}
