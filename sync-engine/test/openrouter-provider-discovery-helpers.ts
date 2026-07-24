import type { OpenRouterProviderOption } from "../../shared/agent-configuration.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import {
  discoverOpenRouterProviders,
  type OpenRouterProviderDiscoverer,
} from "../../sync-engine/openrouter-provider-discovery.ts";

export function openRouterCredential(
  id: string,
  secret = `secret-${id}`,
): ProviderCredentialAccess {
  return {
    accountId: null,
    id,
    isDefault: false,
    label: "OpenRouter key",
    secret,
    source: "api_key",
  };
}

export function providerOption(
  name: string,
  tag: string,
  contextWindow = 131_072,
): OpenRouterProviderOption {
  return {
    contextWindow,
    name,
    pricing: {
      cachedInput: "0.0000001",
      input: "0.0000004",
      output: "0.0000016",
    },
    tag,
  };
}

export function discoverWithResponse(
  response: Response,
): OpenRouterProviderDiscoverer {
  return discoverOpenRouterProviders.withOptions({
    fetch: () => Promise.resolve(response),
  });
}

export function invokeDiscovery(
  discover: OpenRouterProviderDiscoverer,
  model = "vendor/model",
): ReturnType<OpenRouterProviderDiscoverer> {
  return discover("owner", openRouterCredential("credential"), model);
}
