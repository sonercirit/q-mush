import { abortSignalIsAborted } from "../shared/abort-signal.ts";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { throwIfAgentAborted } from "../shared/agent-loop.ts";
import { createRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
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
  readonly signal?: AbortSignal;
}): Promise<AgentModelCatalog> {
  const { discover, pool, selection, signal } = options;
  if (abortSignalIsAborted(signal)) {
    throw createRealtimeCommandError("server_restarting");
  }
  const credentials = await pool.representative(selection.userId, selection);
  if (abortSignalIsAborted(signal)) {
    throw createRealtimeCommandError("server_restarting");
  }
  requireCredentialCandidates(credentials);
  let lastError: unknown;
  for (const credential of credentials) {
    try {
      const catalog = await discover(selection.provider, credential, signal);
      throwIfAgentAborted(signal);
      return catalog;
    } catch (error) {
      if (abortSignalIsAborted(signal)) {
        throw createRealtimeCommandError("server_restarting");
      }
      lastError = error;
    }
  }
  throw createRealtimeCommandError(
    lastError === undefined
      ? credentialUnavailable().code
      : "provider_unavailable",
  );
}
