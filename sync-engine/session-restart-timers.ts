export type RestartTimer = ReturnType<typeof setTimeout> | number;

export type RestartSetTimeout = (
  callback: () => void,
  delay: number,
) => RestartTimer;

export function clearRestartTimer(id: RestartTimer): void {
  globalThis.clearTimeout(id);
}

export const setRestartTimer: RestartSetTimeout = (callback, delay) =>
  globalThis.setTimeout(callback, delay);
