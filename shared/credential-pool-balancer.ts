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

/**
 * Deterministic in-process round robin for credential pools. Pool membership is
 * supplied on every selection, so workspace scoping and removals remain
 * authoritative in the credential store.
 */
export class CredentialPoolBalancer {
  readonly #cooldownMilliseconds: number;
  readonly #now: () => number;
  readonly #states = new Map<string, CredentialPoolState>();

  constructor(options: CredentialPoolOptions = {}) {
    this.#cooldownMilliseconds =
      options.cooldownMilliseconds ?? DEFAULT_CREDENTIAL_COOLDOWN_MILLISECONDS;
    this.#now = options.now ?? Date.now;
  }

  ordered<Member extends CredentialPoolMember>(
    pool: string,
    members: readonly Member[],
  ): readonly Member[] {
    if (members.length === 0) return [];
    const state = this.#state(pool);
    const now = this.#now();
    for (const [credentialId, expiresAt] of state.cooldowns) {
      if (expiresAt <= now) state.cooldowns.delete(credentialId);
    }
    const start = state.cursor % members.length;
    state.cursor = (start + 1) % members.length;
    const rotated = [...members.slice(start), ...members.slice(0, start)];
    return rotated.filter(({ id }) => !state.cooldowns.has(id));
  }

  coolDown(pool: string, credentialId: string): void {
    this.#state(pool).cooldowns.set(
      credentialId,
      this.#now() + this.#cooldownMilliseconds,
    );
  }

  #state(pool: string): CredentialPoolState {
    const current = this.#states.get(pool);
    if (current !== undefined) return current;
    const created = { cooldowns: new Map<string, number>(), cursor: 0 };
    this.#states.set(pool, created);
    return created;
  }
}
