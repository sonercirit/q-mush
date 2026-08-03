import type {
  SessionFailureReconciliation,
  SessionFinisher,
} from "./session-finisher.ts";

export class SessionFailureReconciler {
  readonly #pending = new Map<string, SessionFailureReconciliation>();

  pending(failure: SessionFailureReconciliation): void {
    this.#pending.set(failure.detail.id, failure);
  }

  reconcile(finisher: SessionFinisher): boolean {
    for (const [sessionId, failure] of [...this.#pending]) {
      this.#pending.delete(sessionId);
      try {
        if (failure.recovered === undefined) {
          finisher.finish(failure.detail, failure.userId, failure.error);
        } else {
          finisher.finish(
            failure.detail,
            failure.userId,
            failure.error,
            failure.recovered,
          );
        }
      } catch (error) {
        this.#pending.set(sessionId, failure);
        throw error;
      }
    }
    return this.#pending.size === 0;
  }
}
