export class RestartDeadline {
  readonly #deadlineAt: number;
  readonly #now: () => number;

  constructor(deadlineAt: number, now: () => number = Date.now) {
    this.#deadlineAt = deadlineAt;
    this.#now = now;
  }

  get at(): number {
    return this.#deadlineAt;
  }

  expired(): boolean {
    return this.remaining() === 0;
  }

  remaining(): number {
    return Math.max(0, this.#deadlineAt - this.#now());
  }
}
