export interface RestartDeadline {
  readonly at: number;
  expired(): boolean;
  remaining(): number;
}

export function createRestartDeadline(
  deadlineAt: number,
  now: () => number = Date.now,
): RestartDeadline {
  const remaining = (): number => Math.max(0, deadlineAt - now());
  return {
    at: deadlineAt,
    expired: () => remaining() === 0,
    remaining,
  };
}
