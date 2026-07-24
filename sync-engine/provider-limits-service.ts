import type { ProviderLimitObservation } from "../shared/provider-limits.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { ProviderLimitStore } from "./provider-limit-store.ts";
import type { RealtimeHub } from "./realtime-hub.ts";

export class ProviderLimitsService {
  readonly #now: () => number;
  readonly #realtime: RealtimeHub | undefined;
  readonly #store: ProviderLimitStore;

  constructor(
    store: ProviderLimitStore,
    now: () => number,
    realtime?: RealtimeHub,
  ) {
    this.#store = store;
    this.#now = now;
    this.#realtime = realtime;
  }

  observe(
    userId: string,
    credentialId: string,
    observation: ProviderLimitObservation,
  ): void {
    if (
      this.#store.observe({ credentialId, userId }, observation, this.#now())
    ) {
      this.#realtime?.publishUser(userId, {
        credentialId,
        limits: this.#store.read(userId, credentialId, this.#now()),
        type: "provider_limits",
      });
    }
  }

  apply<T extends AgentSessionSummary>(userId: string, session: T): T {
    return {
      ...session,
      providerLimits: this.read(userId, session.credentialId),
    };
  }

  read(userId: string, credentialId: string) {
    return this.#store.read(userId, credentialId, this.#now());
  }

  detail(
    userId: string,
    detail: AgentSessionDetail | undefined,
  ): AgentSessionDetail | undefined {
    return detail === undefined ? undefined : this.apply(userId, detail);
  }

  list(
    userId: string,
    sessions: readonly AgentSessionSummary[],
  ): readonly AgentSessionSummary[] {
    return sessions.map((session) => this.apply(userId, session));
  }

  snapshot(userId: string) {
    return this.#store.list(userId, this.#now());
  }
}
