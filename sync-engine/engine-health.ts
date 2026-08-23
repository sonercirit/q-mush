import type {
  EngineHealthReason,
  EngineHealthSnapshot,
} from "../shared/engine-health.ts";

type EngineHealthListener = (snapshot: EngineHealthSnapshot) => void;

export function createEngineHealth(
  warn: (message: string, error?: unknown) => void = (message, error) => {
    if (error === undefined) console.warn(message);
    else console.warn(message, error);
  },
) {
  const listeners = new Set<EngineHealthListener>();
  const reasons = new Set<EngineHealthReason>();
  const snapshot = (): EngineHealthSnapshot => ({
    degraded: reasons.size > 0,
    reasons: [...reasons],
  });
  const publish = () => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  return {
    snapshot,
    onChange(listener: EngineHealthListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    degrade(reason: EngineHealthReason, message: string, error?: unknown): void {
      const changed = !reasons.has(reason);
      reasons.add(reason);
      warn(`Q Mush storage health DEGRADED: ${message}`, error);
      if (changed) publish();
    },
    restore(reason: EngineHealthReason): void {
      if (!reasons.delete(reason)) return;
      if (reasons.size === 0) warn("Q Mush storage health recovered");
      publish();
    },
  };
}

export type EngineHealth = ReturnType<typeof createEngineHealth>;
