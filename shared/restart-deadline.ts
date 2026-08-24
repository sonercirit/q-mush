export interface RestartDeadline {
  readonly at: number;
  expired(): boolean;
  remaining(): number;
}

export const createRestartDeadline = (
  deadlineAt: number,
  now: () => number = Date.now,
): RestartDeadline => ({
  at: deadlineAt,
  expired: () => Math.max(0, deadlineAt - now()) === 0,
  remaining: () => Math.max(0, deadlineAt - now()),
});
