import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { SessionStore } from "./session-store.ts";

export interface DrizzleSessionIntegrationRuntime {
  readonly discoverModels: AgentModelDiscoverer;
  readonly draining: () => boolean;
  readonly launch: (
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
  ) => boolean;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly now: () => number;
  readonly store: SessionStore;
}
