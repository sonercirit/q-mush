export interface SessionTiming<StartedAt extends Date | number> {
  readonly activeDurationMs: number;
  readonly activeStartedAt: StartedAt | null;
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
