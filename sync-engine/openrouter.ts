import { isRecord } from "../shared/auth-model.ts";
import type { ProviderLimitObservation } from "../shared/provider-limits.ts";
import {
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
} from "../shared/routes.ts";
import type { GoogleAuth } from "./auth.ts";
import type {
  AuthorizationRequest,
  ConnectedAccountCredential,
  CredentialExchangeRequest,
} from "./connected-account-oauth.ts";
import {
  createPkceAuthorizationUrl,
  readJsonRecord,
  readProviderString,
  readProviderUserId,
  type FlowCookies,
  type OAuthDependencies,
  type OAuthRuntime,
} from "./oauth.ts";
import { createApiKeyMetadataReader } from "./provider-credentials.ts";
import {
  createProviderIntegration,
  readProviderIntegrationConfiguration,
  type ProviderIntegration,
} from "./provider-integration.ts";
import { parseOpenRouterMetadataLimits } from "./provider-limit-parsers.ts";

const OPENROUTER_AUTHORIZATION_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEY_METADATA_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const readOpenRouterApiKeyMetadata = createApiKeyMetadataReader(
  OPENROUTER_KEY_METADATA_URL,
  "OpenRouter could not validate the API key",
);
const OPENROUTER_FLOW_COOKIES: FlowCookies = {
  path: OPENROUTER_OAUTH_PATH,
  state: "q_mush_openrouter_state",
  verifier: "q_mush_openrouter_verifier",
};

export type OpenRouterIntegration = ProviderIntegration;

function createAuthorizationUrl(request: AuthorizationRequest): URL {
  const callbackUrl = new URL(request.callbackUri);
  callbackUrl.searchParams.set("state", request.state);
  const parameters = new URLSearchParams({
    callback_url: callbackUrl.toString(),
  });
  const finishAuthorizationUrl = createPkceAuthorizationUrl;
  return finishAuthorizationUrl(
    OPENROUTER_AUTHORIZATION_URL,
    parameters,
    request.challenge,
  );
}

function validatedCredential(
  details: ConnectedAccountCredential["details"],
  secret: string,
  limits: ProviderLimitObservation | null,
): ConnectedAccountCredential {
  return {
    details,
    ...(limits === null ? {} : { limits }),
    secret,
  };
}

const exchangeCredential = async (
  runtime: OAuthRuntime,
  request: CredentialExchangeRequest,
): Promise<ConnectedAccountCredential> => {
  const response = await runtime.fetch(OPENROUTER_TOKEN_URL, {
    body: JSON.stringify({
      code: request.code,
      code_challenge_method: "S256",
      code_verifier: request.verifier,
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const value = await readJsonRecord(
    response,
    "OpenRouter rejected the authorization code",
  );
  return validatedCredential(
    {
      accountId: readProviderUserId({
        key: "user_id",
        provider: "OpenRouter",
        record: value,
      }),
      label: "OpenRouter account",
    },
    readProviderString(value, "key", "OpenRouter"),
    parseOpenRouterMetadataLimits({ data: value }, runtime.now()),
  );
};

const readCredentialDetails = async (
  runtime: OAuthRuntime,
  apiKey: string,
): Promise<{
  readonly details: {
    readonly accountId: string | null;
    readonly label: string;
  };
  readonly limits?: ProviderLimitObservation;
}> => {
  const value = await readOpenRouterApiKeyMetadata(runtime, apiKey);
  const data = value["data"];

  if (!isRecord(data)) {
    throw new Error("OpenRouter returned invalid API key metadata");
  }

  const limits = parseOpenRouterMetadataLimits(value, runtime.now());
  return {
    details: {
      accountId: readProviderUserId({
        key: "creator_user_id",
        provider: "OpenRouter",
        record: data,
      }),
      label: readProviderString(data, "label", "OpenRouter"),
    },
    ...(limits === null ? {} : { limits }),
  };
};

export function createOpenRouterIntegrationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  auth: GoogleAuth,
  dependencies: OAuthDependencies = {},
): OpenRouterIntegration {
  const configuration = readProviderIntegrationConfiguration(environment, {
    callbackPath: OPENROUTER_OAUTH_CALLBACK_PATH,
    credentialKeyVariable: "OPENROUTER_CREDENTIAL_KEY",
    missingKeyMessage:
      "OPENROUTER_CREDENTIAL_KEY must be set when OPENROUTER_REDIRECT_URI is set",
    redirectUriVariable: "OPENROUTER_REDIRECT_URI",
  });
  return createProviderIntegration({
    auth,
    configuration,
    createOAuthConfiguration: (runtime) => ({
      callbackPath: OPENROUTER_OAUTH_CALLBACK_PATH,
      createAuthorizationUrl,
      exchangeCredential: (request) => exchangeCredential(runtime, request),
      flowCookies: OPENROUTER_FLOW_COOKIES,
      resultParameter: "openrouter",
      userCookie: "q_mush_openrouter_user",
    }),
    dependencies,
    provider: "openrouter",
    readCredentialDetails,
  });
}
