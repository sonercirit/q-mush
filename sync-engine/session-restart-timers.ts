import type { RestartScope } from "./session-runtime.ts";

export type RestartTimer = ReturnType<typeof setTimeout> | number;

/**
 * Identifies the timer a caller arms, so a test seam can target exactly one
 * production timer instead of any timer that happens to share its delay.
 */
type RestartTimerPurpose =
  | { readonly kind: "bounded_drain"; readonly scope: RestartScope }
  | { readonly kind: "credential_retry"; readonly runnerId: string };

export type RestartSetTimeout = (
  callback: () => void,
  delay: number,
  purpose: RestartTimerPurpose,
) => RestartTimer;

export function clearRestartTimer(id: RestartTimer): void {
  globalThis.clearTimeout(id);
}

export const setRestartTimer: RestartSetTimeout = (callback, delay) =>
  globalThis.setTimeout(callback, delay);
