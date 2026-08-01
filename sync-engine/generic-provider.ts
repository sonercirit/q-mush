import { createCredentialCipher } from "../shared/credential-cipher.ts";
import type { ProviderCredentialDetails } from "../shared/provider-credential-store.ts";
import {
  AgentModelDiscoveryError,
  discoverAgentModels,
} from "./agent-model-discovery.ts";
import type { GoogleAuth } from "./auth.ts";
import { normalizeGenericProviderBaseUrl } from "./generic-provider-url.ts";
import {
  normalizeOptionalValue,
  type OAuthDependencies,
  type OAuthRuntime,
} from "./oauth.ts";
import {
  InvalidProviderApiKeyError,
  type ProviderCredentialInputDetails,
} from "./provider-credentials.ts";
import {
  createProviderIntegration,
  type ProviderIntegration,
  type ProviderIntegrationConfiguration,
} from "./provider-integration.ts";
import {
  type ProviderQuotaReader,
  unsupportedQuotaReset,
} from "./provider-quota.ts";

export type GenericProviderIntegration = ProviderIntegration;

const unavailableGenericQuota: ProviderQuotaReader = () =>
  Promise.reject(new Error("Generic provider quota is unavailable"));

function genericProviderConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderIntegrationConfiguration | undefined {
  const encodedCredentialKey = normalizeOptionalValue(
    environment["GENERIC_CREDENTIAL_KEY"],
  );
  return encodedCredentialKey === undefined
    ? undefined
    : {
        cipher: createCredentialCipher(
          encodedCredentialKey,
          "GENERIC_CREDENTIAL_KEY",
        ),
      };
}

async function readGenericCredentialDetails(
  runtime: Pick<OAuthRuntime, "fetch">,
  apiKey: string,
  details: ProviderCredentialInputDetails,
): Promise<ProviderCredentialDetails> {
  const { baseUrl, label } = details;
  if (baseUrl === undefined || label === undefined) {
    throw new Error("The generic provider endpoint details are invalid");
  }
  try {
    await discoverAgentModels(
      "generic",
      { accountId: null, baseUrl, secret: apiKey, source: "api_key" },
      (request) => runtime.fetch(request),
    );
  } catch (error) {
    if (
      error instanceof AgentModelDiscoveryError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new InvalidProviderApiKeyError();
    }
    throw error;
  }
  return { accountId: null, baseUrl, label };
}

type GenericProviderEnvironment = Readonly<Record<string, string | undefined>>;

export function createGenericIntegrationFromEnvironment(
  environment: GenericProviderEnvironment,
  auth: GoogleAuth,
  dependencies?: OAuthDependencies,
): GenericProviderIntegration {
  const resolvedDependencies = dependencies ?? {};
  return createProviderIntegration({
    auth,
    configuration: genericProviderConfiguration(environment),
    credentialOptions: {
      apiKeyRequired: false,
      labelRequired: true,
      readBaseUrl: normalizeGenericProviderBaseUrl,
    },
    dependencies: resolvedDependencies,
    createQuotaReader: () => unavailableGenericQuota,
    createQuotaResetter: () => unsupportedQuotaReset,
    provider: "generic",
    readCredentialDetails: (runtime, apiKey, details) =>
      readGenericCredentialDetails(runtime, apiKey, details),
  });
}
