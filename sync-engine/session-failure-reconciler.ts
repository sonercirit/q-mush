import type {
  SessionFailureReconciliation,
  SessionFinisher,
} from "./session-finisher.ts";

export interface SessionFailureReconciler {
  hasPending(): boolean;
  pending(failure: SessionFailureReconciliation): void;
  reconcile(finisher: SessionFinisher): boolean;
}

export function createSessionFailureReconciler(): SessionFailureReconciler {
  const failures = new Map<string, SessionFailureReconciliation>();
  return {
    hasPending: () => failures.size > 0,
    pending(failure) {
      failures.set(failure.detail.id, failure);
    },
    reconcile(finisher) {
      for (const [sessionId, failure] of [...failures]) {
        failures.delete(sessionId);
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
          failures.set(sessionId, failure);
          throw error;
        }
      }
      return failures.size === 0;
    },
  };
}
