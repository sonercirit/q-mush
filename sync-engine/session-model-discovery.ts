import type { ProviderId } from "../shared/provider-credential-store.ts";
import { isProviderId } from "../shared/provider-id.ts";
import { readIdentifier } from "../shared/validation.ts";
import {
  safeAgentModelDiscoveryError,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";
import type { CredentialDiscoveryRequestOptions } from "./session-credential-discovery-options.ts";
import { abortedServerRestartResponse } from "./session-restart-gate.ts";
import {
  requestSessionWorkspaceId,
  type SessionWorkspaceReader,
} from "./session-workspace.ts";

interface ModelDiscoveryInput {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId: string;
}

type WithModelCredential = (
  userId: string,
  selection: ModelDiscoveryInput,
  action: SessionCredentialAction,
) => Promise<Response>;

function readModelDiscoveryInput(
  request: Request,
  userId: string,
  workspaces: SessionWorkspaceReader,
): ModelDiscoveryInput | undefined {
  const search = new URL(request.url).searchParams;
  const credentialId = readIdentifier(search.get("credentialId"));
  const providerValue = search.get("provider");
  const provider = isProviderId(providerValue) ? providerValue : undefined;
  const workspaceId = requestSessionWorkspaceId(request, userId, workspaces);
  return credentialId === undefined ||
    provider === undefined ||
    workspaceId === undefined
    ? undefined
    : { credentialId, provider, workspaceId };
}

export async function modelsForUser(
  options: CredentialDiscoveryRequestOptions<WithModelCredential> & {
    readonly discoverModels: AgentModelDiscoverer;
    readonly workspaces: SessionWorkspaceReader;
  },
): Promise<Response> {
  const selection = readModelDiscoveryInput(
    options.request,
    options.user.id,
    options.workspaces,
  );
  return selection === undefined
    ? createApiError("invalid_request", 400)
    : options.withCredential(options.user.id, selection, (credential) =>
        discoveredModelsResponse(
          options.discoverModels,
          selection.provider,
          credential,
          options.signal,
        ),
      );
}

async function discoveredModelsResponse(
  discoverModels: AgentModelDiscoverer,
  provider: ProviderId,
  credential: Parameters<AgentModelDiscoverer>[1],
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const restartResponse = abortedServerRestartResponse(signal);
    if (restartResponse !== undefined) return restartResponse;
    return createJsonResponse(
      await discoverModels(provider, credential, signal),
    );
  } catch (error) {
    return (
      abortedServerRestartResponse(signal) ??
      createApiError(
        "provider_unavailable",
        502,
        safeAgentModelDiscoveryError(error),
      )
    );
  }
}
