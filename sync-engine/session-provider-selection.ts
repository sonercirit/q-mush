import {
  readOpenRouterProviderRouting,
  type OpenRouterProviderCatalog,
} from "../shared/agent-configuration.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { mapWithParallelConcurrency } from "../shared/parallel.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type {
  PreparedSessionCredentialProviderState,
  SessionCredentialMetadataUpdate,
  SessionCredentialReassignmentSnapshot,
} from "./session-credential-reassignment-store.ts";
import { readIdentifier } from "./session-request-helpers.ts";
import { requestSearchSelection } from "./session-search-selection.ts";

function endpointProviderTag(selection: string | null): string | undefined {
  const routing = readOpenRouterProviderRouting(selection);
  return routing?.type === "provider" ? routing.tag : undefined;
}

function selectedProvider(
  catalog: OpenRouterProviderCatalog,
  selection: string | null,
) {
  const tag = endpointProviderTag(selection);
  return tag === undefined
    ? undefined
    : catalog.providers.find((provider) => provider.tag === tag);
}

interface CredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId: string;
}

type CredentialResponseAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export type WithCredential = (
  userId: string,
  selection: CredentialSelection,
  action: CredentialResponseAction,
) => Promise<Response>;

/**
 * The supplied credential reader is the authorization hook. Workspace scopes
 * must resolve through this callback so endpoint discovery cannot widen access.
 */
export async function openRouterProvidersForUser(options: {
  readonly discover: OpenRouterProviderDiscoverer;
  readonly request: Request;
  readonly user: AuthenticatedUser;
  readonly withCredential: WithCredential;
}): Promise<Response> {
  const { credentialId, search } = requestSearchSelection(options.request);
  const model = search.get("model");
  const workspaceId = readIdentifier(search.get("workspaceId"));
  if (
    credentialId === undefined ||
    model === null ||
    workspaceId === undefined
  ) {
    return createApiError("invalid_request", 400);
  }
  return options.withCredential(
    options.user.id,
    { credentialId, provider: "openrouter", workspaceId },
    async (credential) => {
      try {
        return createJsonResponse(
          await options.discover(options.user.id, credential, model),
        );
      } catch (error) {
        return error instanceof Error && error.message.includes("identifier")
          ? createApiError("invalid_request", 400)
          : createApiError("provider_unavailable", 502);
      }
    },
  );
}

export type OpenRouterSessionCredentialPreparationResult =
  | { readonly error: "provider_unavailable" | "validation_failed" }
  | { readonly preparedProviderState: PreparedSessionCredentialProviderState };

export async function prepareOpenRouterSessionCredentialProviderState(options: {
  readonly credential: ProviderCredentialAccess;
  readonly discover: OpenRouterProviderDiscoverer;
  readonly ownerId: string;
  readonly snapshot: SessionCredentialReassignmentSnapshot;
}): Promise<OpenRouterSessionCredentialPreparationResult> {
  const selected = options.snapshot.sessions.flatMap((session) => {
    const providerTag = endpointProviderTag(session.openRouterProviderTag);
    return providerTag === undefined ? [] : [{ ...session, providerTag }];
  });
  const models = [...new Set(selected.map(({ model }) => model))];
  let catalogs: readonly (readonly [
    string,
    Awaited<ReturnType<OpenRouterProviderDiscoverer>>,
  ])[];
  try {
    catalogs = await mapWithParallelConcurrency(
      models,
      async (model) =>
        [
          model,
          await options.discover(options.ownerId, options.credential, model, {
            force: true,
          }),
        ] as const,
    );
  } catch {
    return { error: "validation_failed" };
  }
  const providersByModel = new Map(catalogs);
  const metadataUpdates: SessionCredentialMetadataUpdate[] = [];
  for (const session of selected) {
    const provider = selectedProvider(
      providersByModel.get(session.model) ?? { providers: [] },
      session.providerTag,
    );
    if (provider === undefined) {
      return { error: "provider_unavailable" };
    }
    metadataUpdates.push({
      id: session.id,
      maxContextTokens: provider.contextWindow,
      providerPricing: provider.pricing,
    });
  }
  return {
    preparedProviderState: {
      expectedSessions: options.snapshot.sessions,
      metadataUpdates,
    },
  };
}

export type SessionMetadataResult =
  | { readonly error: "provider_unavailable" | "validation_failed" }
  | {
      readonly maxContextTokens: number | null;
      readonly providerPricing: AgentSessionSummary["providerPricing"];
    };

/**
 * Reassignment should call this with the candidate credential before changing
 * a session whose explicit tag is non-null. That keeps provider tags valid
 * under same-provider credential and workspace-scope changes.
 */
export function requireSessionMetadata(
  metadata: SessionMetadataResult,
): Exclude<SessionMetadataResult, { readonly error: string }> {
  if ("error" in metadata) {
    throw new RealtimeCommandError(
      metadata.error === "provider_unavailable"
        ? "openrouter_provider_unavailable"
        : "openrouter_provider_validation_failed",
    );
  }
  return metadata;
}

export function sessionMetadataFromDependencies(options: {
  readonly credential: ProviderCredentialAccess;
  readonly dependencies: {
    readonly discoverModels: AgentModelDiscoverer;
    readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  };
  readonly input: Parameters<typeof sessionMetadata>[0]["input"];
  readonly ownerId: string;
}): Promise<SessionMetadataResult> {
  return sessionMetadata({
    credential: options.credential,
    discoverModels: options.dependencies.discoverModels,
    discoverProviders: options.dependencies.discoverOpenRouterProviders,
    input: options.input,
    ownerId: options.ownerId,
  });
}

export async function sessionMetadata(options: {
  readonly credential: ProviderCredentialAccess;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverProviders: OpenRouterProviderDiscoverer;
  readonly input: {
    readonly model: string;
    readonly openRouterProviderTag: string | null;
    readonly provider: ProviderId;
  };
  readonly ownerId: string;
}): Promise<SessionMetadataResult> {
  const { credential, input } = options;
  if (endpointProviderTag(input.openRouterProviderTag) !== undefined) {
    try {
      const catalog = await options.discoverProviders(
        options.ownerId,
        credential,
        input.model,
        { force: true },
      );
      const selected = selectedProvider(catalog, input.openRouterProviderTag);
      return selected === undefined
        ? { error: "provider_unavailable" }
        : {
            maxContextTokens: selected.contextWindow,
            providerPricing: selected.pricing,
          };
    } catch {
      return { error: "validation_failed" };
    }
  }

  try {
    const catalog = await options.discoverModels(input.provider, credential);
    const model = catalog.models.find(({ id }) => id === input.model);
    return {
      maxContextTokens: model?.contextWindow ?? null,
      providerPricing: model?.pricing ?? null,
    };
  } catch {
    return { maxContextTokens: null, providerPricing: null };
  }
}
