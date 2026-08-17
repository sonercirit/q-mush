import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import {
  discoverOpenRouterProviders,
  type OpenRouterProviderDiscoverer,
} from "../../sync-engine/openrouter-provider-discovery.ts";

export function openRouterCredential(
  id = "credential-1",
): ProviderCredentialAccess {
  return {
    accountId: null,
    id,
    isDefault: false,
    label: "OpenRouter key",
    secret: `secret-${id}`,
    source: "api_key",
  };
}

export function endpoint(
  tag: string,
  providerName: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    context_length: 131_072,
    pricing: {
      completion: "0.0000016",
      input_cache_read: "0.0000001",
      prompt: "0.0000004",
    },
    provider_name: providerName,
    status: 0,
    tag,
    ...overrides,
  };
}

export function endpointResponse(endpoints: readonly unknown[]): Response {
  return Response.json({ data: { endpoints } });
}

export function discoverWithResponse(
  response: Response,
): OpenRouterProviderDiscoverer {
  return discoverOpenRouterProviders.withOptions({
    fetch: () => Promise.resolve(response),
  });
}
