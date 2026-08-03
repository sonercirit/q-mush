import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import {
  credentialUnavailable,
  requireCredentialCandidates,
} from "./session-realtime-errors.ts";

type ModelDiscoverySelection = Parameters<
  ModelCredentialPool["representative"]
>[1] & {
  readonly userId: string;
};

export async function discoverSessionModelsFromPool(options: {
  readonly discover: AgentModelDiscoverer;
  readonly pool: ModelCredentialPool;
  readonly selection: ModelDiscoverySelection;
}): Promise<AgentModelCatalog> {
  const { discover, pool, selection } = options;
  const credentials = await pool.representative(selection.userId, selection);
  requireCredentialCandidates(credentials);
  let lastError: unknown;
  for (const credential of credentials) {
    try {
      return await discover(selection.provider, credential);
    } catch (error) {
      lastError = error;
    }
  }
  throw new RealtimeCommandError(
    lastError === undefined
      ? credentialUnavailable().code
      : "provider_unavailable",
  );
}
