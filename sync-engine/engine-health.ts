import type {
  EngineHealthReason,
  EngineHealthSnapshot,
} from "../shared/engine-health.ts";

type EngineHealthListener = (snapshot: EngineHealthSnapshot) => void;

export class EngineHealth {
  readonly #listeners = new Set<EngineHealthListener>();
  readonly #reasons = new Set<EngineHealthReason>();
  readonly #warn: (message: string, error?: unknown) => void;

  constructor(
    warn: (message: string, error?: unknown) => void = (message, error) => {
      if (error === undefined) {
        console.warn(message);
      } else {
        console.warn(message, error);
      }
    },
  ) {
    this.#warn = warn;
  }

  snapshot(): EngineHealthSnapshot {
    return {
      degraded: this.#reasons.size > 0,
      reasons: [...this.#reasons],
    };
  }

  onChange(listener: EngineHealthListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  degrade(reason: EngineHealthReason, message: string, error?: unknown): void {
    const changed = !this.#reasons.has(reason);
    this.#reasons.add(reason);
    this.#warn(`Q Mush storage health DEGRADED: ${message}`, error);
    if (changed) {
      this.#publish();
    }
  }

  restore(reason: EngineHealthReason): void {
    if (!this.#reasons.delete(reason)) {
      return;
    }
    if (this.#reasons.size === 0) {
      this.#warn("Q Mush storage health recovered");
    }
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
