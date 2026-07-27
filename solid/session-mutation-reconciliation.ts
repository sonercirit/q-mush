import {
  normalizedSessionMutationError,
  sessionMutationOutcomeIsUnknown,
} from "./session-mutations.ts";

export async function reconcileUnknownSessionMutation(options: {
  readonly error: unknown;
  readonly reconcile: (error: unknown) => Promise<void>;
  readonly reject: (error: unknown) => void;
}): Promise<void> {
  const normalized = normalizedSessionMutationError(options.error);
  if (sessionMutationOutcomeIsUnknown(normalized)) {
    await options.reconcile(normalized);
  } else {
    options.reject(normalized);
  }
}
