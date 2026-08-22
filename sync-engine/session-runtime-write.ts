type SessionRuntimeApply = (
  sessionId: string,
  now: number,
  generation: number,
) => void;

export type SessionRuntimeWriter = (apply: SessionRuntimeApply) => void;

export function invokeRuntimeWrite(
  now: () => number,
  generation: number,
  action: (timestamp: number, generation: number) => void,
  notify: () => void,
): void {
  action(now(), generation);
  notify();
}
