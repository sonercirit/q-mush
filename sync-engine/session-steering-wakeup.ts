import { abortSignalError } from "../shared/validation.ts";

type SteeringWake = () => void;

const steeringWaiters = new Map<string, Set<SteeringWake>>();

export function notifySessionSteeringInput(sessionId: string): void {
  const waiters = steeringWaiters.get(sessionId);
  if (waiters === undefined) {
    return;
  }
  for (const wake of [...waiters]) {
    wake();
  }
}

export function waitForSessionSteeringInput(
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      abortSignalError(signal, "The agent session was stopped"),
    );
  }
  return new Promise((resolve, reject) => {
    const waiters = steeringWaiters.get(sessionId) ?? new Set<SteeringWake>();
    const cleanup = (): void => {
      signal.removeEventListener("abort", aborted);
      waiters.delete(wake);
      if (waiters.size === 0) {
        steeringWaiters.delete(sessionId);
      }
    };
    const wake = (): void => {
      cleanup();
      resolve();
    };
    const aborted = (): void => {
      cleanup();
      reject(abortSignalError(signal, "The agent session was stopped"));
    };
    waiters.add(wake);
    steeringWaiters.set(sessionId, waiters);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
