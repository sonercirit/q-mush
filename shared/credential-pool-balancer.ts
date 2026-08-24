const DEFAULT_CREDENTIAL_COOLDOWN_MILLISECONDS = 30_000;

interface CredentialPoolMember {
  readonly id: string;
}

interface CredentialPoolState {
  readonly cooldowns: Map<string, number>;
  cursor: number;
}

export interface CredentialPoolOptions {
  readonly cooldownMilliseconds?: number;
  readonly now?: () => number;
}

export interface CredentialPoolBalancer {
  readonly coolDown: (pool: string, credentialId: string) => void;
  readonly ordered: <Member extends CredentialPoolMember>(
    pool: string,
    members: readonly Member[],
  ) => readonly Member[];
}

/** Deterministic in-process round robin for credential pools. */
export function createCredentialPoolBalancer(
  options: CredentialPoolOptions = {},
): CredentialPoolBalancer {
  const cooldownMilliseconds =
    options.cooldownMilliseconds ?? DEFAULT_CREDENTIAL_COOLDOWN_MILLISECONDS;
  const now = options.now ?? Date.now;
  const states = new Map<string, CredentialPoolState>();
  const state = (pool: string): CredentialPoolState => {
    const current = states.get(pool);
    if (current !== undefined) return current;
    const created = { cooldowns: new Map<string, number>(), cursor: 0 };
    states.set(pool, created);
    return created;
  };
  return {
    coolDown(pool, credentialId) {
      state(pool).cooldowns.set(credentialId, now() + cooldownMilliseconds);
    },
    ordered(pool, members) {
      if (members.length === 0) return [];
      const poolState = state(pool);
      const timestamp = now();
      for (const [credentialId, expiresAt] of poolState.cooldowns) {
        if (expiresAt <= timestamp) poolState.cooldowns.delete(credentialId);
      }
      const start = poolState.cursor % members.length;
      poolState.cursor = (start + 1) % members.length;
      const rotated = [...members.slice(start), ...members.slice(0, start)];
      return rotated.filter(({ id }) => !poolState.cooldowns.has(id));
    },
  };
}
