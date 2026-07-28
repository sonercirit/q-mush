export interface SessionTiming<StartedAt extends Date | number> {
  readonly activeDurationMs: number;
  readonly activeStartedAt: StartedAt | null;
}

export function formatSessionTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m`;
  }
  return minutes > 0
    ? `${String(minutes)}m ${String(remainingSeconds)}s`
    : `${String(remainingSeconds)}s`;
}

export function activeSessionDuration<StartedAt extends Date | number>(
  session: SessionTiming<StartedAt>,
  now: number,
): number {
  const startedAt = session.activeStartedAt;
  const startedAtMilliseconds: number | null =
    startedAt instanceof Date ? startedAt.getTime() : startedAt;
  return (
    session.activeDurationMs +
    (startedAtMilliseconds === null
      ? 0
      : Math.max(0, now - startedAtMilliseconds))
  );
}
