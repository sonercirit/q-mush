export interface SessionRestartTestClock {
  readonly advance: (milliseconds: number) => void;
  readonly clearTimeout: (id: number | ReturnType<typeof setTimeout>) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => number;
}

export function createSessionRestartTestClock(
  initialNow = 1_000,
): SessionRestartTestClock {
  let clockNow = initialNow;
  const timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();
  let nextId = 1;

  return {
    advance(milliseconds): void {
      clockNow += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clockNow) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    clearTimeout(id): void {
      if (typeof id === "number") {
        timers.delete(id);
      }
    },
    now: () => clockNow,
    setTimeout(callback, delay): number {
      const id = nextId++;
      timers.set(id, { at: clockNow + delay, callback });
      return id;
    },
  };
}
