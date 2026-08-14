import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { isProviderId } from "../shared/provider-id.ts";
import { readIdentifier } from "../shared/validation.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery-fetch.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { SessionCredentialAction } from "./session-credential-access.ts";
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

export async function modelsForUser(options: {
  readonly discoverModels: AgentModelDiscoverer;
  readonly request: Request;
  readonly user: AuthenticatedUser;
  readonly withCredential: WithModelCredential;
  readonly workspaces: SessionWorkspaceReader;
}): Promise<Response> {
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
        ),
      );
}

async function discoveredModelsResponse(
  discoverModels: AgentModelDiscoverer,
  provider: ProviderId,
  credential: Parameters<AgentModelDiscoverer>[1],
): Promise<Response> {
  try {
    return createJsonResponse(await discoverModels(provider, credential));
  } catch (error) {
    return createApiError(
      "provider_unavailable",
      502,
      safeAgentModelDiscoveryError(error),
    );
  }
}
