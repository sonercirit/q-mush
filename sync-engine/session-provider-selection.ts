import { abortSignalIsAborted } from "../shared/abort-signal.ts";
import {
  readOpenRouterProviderRouting,
  type OpenRouterProviderCatalog,
} from "../shared/agent-configuration.ts";
import { throwIfAgentAborted } from "../shared/agent-loop.ts";
import { mapWithParallelConcurrency } from "../shared/parallel.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createRealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import { optionalSignal } from "../shared/validation.ts";
import { isCredentialRejectionError } from "./agent-model-discovery-fetch.ts";
import {
  discoverModelOption,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { PooledCredentialDiscoveryRequestOptions } from "./session-credential-discovery-options.ts";
import type {
  PreparedSessionCredentialProviderState,
  SessionCredentialMetadataUpdate,
  SessionCredentialReassignmentSnapshot,
} from "./session-credential-reassignment-store.ts";
import { type SessionModelDiscoveryDependencies } from "./session-model-discovery-dependencies.ts";
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

function restartResponseIfNeeded(
  signal: AbortSignal | undefined,
): Response | undefined {
  if (!abortSignalIsAborted(signal)) return undefined;
  return createApiError("server_restarting", 503);
}

function restartResponseOrThrow(
  signal: AbortSignal | undefined,
  error: unknown,
): Response {
  const restarting = restartResponseIfNeeded(signal);
  if (restarting !== undefined) return restarting;
  throw error;
}

/**
 * The supplied credential reader is the authorization hook. Workspace scopes
 * must resolve through this callback so endpoint discovery cannot widen access.
 */
export async function openRouterProvidersForUser(
  options: PooledCredentialDiscoveryRequestOptions<WithCredential> & {
    readonly discover: OpenRouterProviderDiscoverer;
  },
): Promise<Response> {
  const initialRestart = restartResponseIfNeeded(options.signal);
  if (initialRestart !== undefined) return initialRestart;
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
  const selection = {
    credentialId,
    provider: "openrouter" as const,
    workspaceId,
  };
  const discover = async (
    credential: ProviderCredentialAccess,
  ): Promise<Response> => {
    try {
      const catalog = await options.discover(
        options.user.id,
        credential,
        model,
        optionalSignal(options.signal),
      );
      throwIfAgentAborted(options.signal);
      const response = createJsonResponse(catalog);
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.includes("identifier")) {
        return createApiError("invalid_request", 400);
      }
      return restartResponseOrThrow(options.signal, error);
    }
  };
  if (isBalancedCredentialId("openrouter", credentialId)) {
    const credentials = await options.pool.representative(
      options.user.id,
      selection,
    );
    for (const credential of credentials) {
      try {
        return await discover(credential);
      } catch (error) {
        let restarting: Response;
        try {
          restarting = restartResponseOrThrow(options.signal, error);
        } catch {
          // Discovery is read-only; any pool member may represent the selection.
          continue;
        }
        return restarting;
      }
    }
    return createApiError("provider_unavailable", 502);
  }
  return options.withCredential(
    options.user.id,
    selection,
    async (credential) => {
      try {
        return await discover(credential);
      } catch {
        return createApiError("provider_unavailable", 502);
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
      adaptiveThinking: null,
      id: session.id,
      maxContextTokens: provider.contextWindow,
      maxOutputTokens: null,
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

export type SessionRequestModelMetadata = Pick<
  AgentSessionDetail,
  | "adaptiveThinking"
  | "maxContextTokens"
  | "maxOutputTokens"
  | "providerPricing"
>;

export type SessionMetadataResult =
  | { readonly error: "provider_unavailable" | "validation_failed" }
  | SessionRequestModelMetadata;

/**
 * Reassignment should call this with the candidate credential before changing
 * a session whose explicit tag is non-null. That keeps provider tags valid
 * under same-provider credential and workspace-scope changes.
 */
function requireSessionMetadata(
  metadata: SessionMetadataResult,
): Exclude<SessionMetadataResult, { readonly error: string }> {
  if ("error" in metadata) {
    throw createRealtimeCommandError(
      metadata.error === "provider_unavailable"
        ? "openrouter_provider_unavailable"
        : "openrouter_provider_validation_failed",
    );
  }
  return metadata;
}

export function optionalCredentialRejection(
  rejectCredentialErrors: boolean | undefined,
): Readonly<{ rejectCredentialErrors?: boolean }> {
  return rejectCredentialErrors === undefined ? {} : { rejectCredentialErrors };
}

interface SessionMetadataInput {
  readonly model: string;
  readonly openRouterProviderTag: string | null;
  readonly provider: ProviderId;
}

interface SessionMetadataCoreOptions {
  readonly credential: ProviderCredentialAccess;
  readonly input: SessionMetadataInput;
  readonly ownerId: string;
  readonly rejectCredentialErrors?: boolean;
  readonly signal?: AbortSignal;
}

interface SessionMetadataOptions extends SessionMetadataCoreOptions {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverProviders: OpenRouterProviderDiscoverer;
}

interface SessionMetadataDependencyOptions extends SessionMetadataCoreOptions {
  readonly dependencies: SessionModelDiscoveryDependencies;
}

export async function discoverRequiredSessionMetadata(
  options: SessionMetadataDependencyOptions,
) {
  return requireSessionMetadata(await sessionMetadataFromDependencies(options));
}

export function sessionMetadataFromDependencies(
  options: SessionMetadataDependencyOptions,
): Promise<SessionMetadataResult> {
  return sessionMetadata({
    credential: options.credential,
    discoverModels: options.dependencies.discoverModels,
    discoverProviders: options.dependencies.discoverOpenRouterProviders,
    input: options.input,
    ownerId: options.ownerId,
    ...optionalSignal(options.signal),
    ...optionalCredentialRejection(options.rejectCredentialErrors),
  });
}

function credentialFailure(
  options: SessionMetadataOptions,
  error: unknown,
  fallback: SessionMetadataResult,
): SessionMetadataResult {
  // Cancellation is not missing metadata: a deadline or session stop must
  // propagate so callers do not proceed to create work after timing out.
  if (options.signal?.aborted === true) {
    throw error;
  }
  if (options.rejectCredentialErrors === true) {
    if (isCredentialRejectionError(error)) throw error;
    throw createRealtimeCommandError("provider_unavailable");
  }
  return fallback;
}

function rethrowRestartOrReturn(
  options: SessionMetadataOptions,
  error: unknown,
  fallback: SessionMetadataResult,
): SessionMetadataResult {
  if (abortSignalIsAborted(options.signal)) throw error;
  return credentialFailure(options, error, fallback);
}

export async function sessionMetadata(
  options: SessionMetadataOptions,
): Promise<SessionMetadataResult> {
  const { credential, input } = options;
  if (endpointProviderTag(input.openRouterProviderTag) !== undefined) {
    try {
      const catalog = await options.discoverProviders(
        options.ownerId,
        credential,
        input.model,
        {
          force: true,
          ...optionalSignal(options.signal),
        },
      );
      const selected = selectedProvider(catalog, input.openRouterProviderTag);
      return selected === undefined
        ? { error: "provider_unavailable" }
        : {
            adaptiveThinking: null,
            maxContextTokens: selected.contextWindow,
            // OpenRouter serving-provider listings carry no output limit.
            maxOutputTokens: null,
            providerPricing: selected.pricing,
          };
    } catch (error) {
      return rethrowRestartOrReturn(options, error, {
        error: "validation_failed",
      });
    }
  }

  try {
    const model = await discoverModelOption(
      options.discoverModels,
      input.provider,
      credential,
      input.model,
      options.signal,
    );
    return {
      adaptiveThinking: model?.adaptiveThinking ?? null,
      maxContextTokens: model?.contextWindow ?? null,
      maxOutputTokens: model?.maxOutputTokens ?? null,
      providerPricing: model?.pricing ?? null,
    };
  } catch (error) {
    return rethrowRestartOrReturn(options, error, {
      adaptiveThinking: null,
      maxContextTokens: null,
      maxOutputTokens: null,
      providerPricing: null,
    });
  }
}
