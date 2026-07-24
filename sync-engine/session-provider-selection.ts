import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import {
  readIdentifier,
  requestSearchParameters,
} from "./session-request-helpers.ts";

interface CredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export type CredentialResponseAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export type WithCredential = (
  userId: string,
  selection: CredentialSelection,
  action: CredentialResponseAction,
) => Promise<Response>;

export async function openRouterProvidersForUser(options: {
  readonly discover: OpenRouterProviderDiscoverer;
  readonly request: Request;
  readonly user: AuthenticatedUser;
  readonly withCredential: WithCredential;
}): Promise<Response> {
  const search = requestSearchParameters(options.request);
  const credentialId = readIdentifier(search.get("credentialId"));
  const model = search.get("model");
  if (credentialId === undefined || model === null) {
    return createApiError("invalid_request", 400);
  }
  return options.withCredential(
    options.user.id,
    { credentialId, provider: "openrouter" },
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

export async function sessionMetadata(options: {
  readonly credential: ProviderCredentialAccess;
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverProviders: OpenRouterProviderDiscoverer;
  readonly input: {
    readonly model: string;
    readonly openRouterProviderTag: string | null;
    readonly provider: "openai" | "openrouter";
  };
  readonly ownerId: string;
}): Promise<
  | { readonly error: "provider_unavailable" | "validation_failed" }
  | {
      readonly maxContextTokens: number | null;
      readonly providerPricing: AgentSessionSummary["providerPricing"];
    }
> {
  const { credential, input } = options;
  if (input.openRouterProviderTag !== null) {
    try {
      const catalog = await options.discoverProviders(
        options.ownerId,
        credential,
        input.model,
        { force: true },
      );
      const selected = catalog.providers.find(
        ({ tag }) => tag === input.openRouterProviderTag,
      );
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
