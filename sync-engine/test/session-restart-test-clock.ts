export class SessionRestartTestClock {
  #now: number;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();
  #nextId = 1;

  constructor(now = 1_000) {
    this.#now = now;
  }

  readonly clearTimeout = (
    id: number | ReturnType<typeof setTimeout>,
  ): void => {
    if (typeof id === "number") {
      this.#timers.delete(id);
    }
  };

  readonly now = (): number => this.#now;

  readonly setTimeout = (callback: () => void, delay: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delay, callback });
    return id;
  };

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.#now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}
