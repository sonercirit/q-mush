import { Buffer } from "node:buffer";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import { APP_PATH, OPENAI_OAUTH_CALLBACK_PATH } from "../shared/routes.ts";
import type { GoogleAuth } from "./auth.ts";
import type {
  AuthorizationRequest,
  ConnectedAccountCredential,
  CredentialExchangeRequest,
} from "./connected-account-oauth.ts";
import {
  createPkceAuthorizationUrl,
  normalizeOptionalValue,
  postFormJson,
  readProviderString,
  type FlowCookies,
  type OAuthDependencies,
  type OAuthRuntime,
} from "./oauth.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import { openAiRefreshReauthenticationError } from "./openai-refresh-rejection.ts";
import { createApiKeyMetadataReader } from "./provider-credentials.ts";
import {
  createProviderIntegration,
  readProviderIntegrationConfiguration,
  type ProviderIntegration,
  type ProviderIntegrationConfiguration,
} from "./provider-integration.ts";
import {
  createCodexQuotaResetter,
  createOpenAiQuotaReader,
} from "./provider-quota.ts";

const OPENAI_AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_KEY_METADATA_URL = "https://api.openai.com/v1/me";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_LOOPBACK_CALLBACK_PORT = 1455;
const OPENAI_LOOPBACK_CALLBACK_PATH = "/auth/callback";
const OPENAI_LOOPBACK_REDIRECT_URI = `http://localhost:${String(OPENAI_LOOPBACK_CALLBACK_PORT)}${OPENAI_LOOPBACK_CALLBACK_PATH}`;
const OPENAI_FLOW_COOKIES: FlowCookies = {
  path: "/",
  state: "q_mush_openai_state",
  verifier: "q_mush_openai_verifier",
};
const AUTHORIZATION_CODE_GRANT = "authorization_code";
const REFRESH_TOKEN_GRANT = "refresh_token";
const TOKEN_REFRESH_LEEWAY_MILLISECONDS = 60_000;
const readOpenAiApiKeyMetadata = createApiKeyMetadataReader(
  OPENAI_KEY_METADATA_URL,
  "OpenAI could not validate the API key",
);

interface OpenAiConfiguration extends ProviderIntegrationConfiguration {
  readonly clientId: string;
  readonly redirectUri?: string;
}

interface OpenAiAccountDetails {
  readonly accountId: string | null;
  readonly label: string;
}

export type OpenAiIntegration = ProviderIntegration;

function createAuthorizationUrl(
  clientId: string,
  request: AuthorizationRequest,
): URL {
  const parameters = new URLSearchParams({
    client_id: clientId,
    codex_cli_simplified_flow: "true",
    id_token_add_organizations: "true",
    originator: "q_mush",
    redirect_uri: request.callbackUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: request.state,
  });
  return createPkceAuthorizationUrl(
    OPENAI_AUTHORIZATION_URL,
    parameters,
    request.challenge,
  );
}

function readTokenSecret(
  runtime: OAuthRuntime,
  tokens: Readonly<Record<string, unknown>>,
  fallbackRefreshToken?: string,
): string {
  const access = readProviderString(tokens, "access_token", "OpenAI");
  const refreshValue = tokens["refresh_token"];
  const refresh =
    refreshValue === undefined && fallbackRefreshToken !== undefined
      ? fallbackRefreshToken
      : readProviderString(tokens, "refresh_token", "OpenAI");
  const expiresIn = tokens["expires_in"];

  if (
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("OpenAI returned an invalid expires_in");
  }

  const expires = runtime.now() + expiresIn * 1000;

  if (!Number.isSafeInteger(expires)) {
    throw new Error("OpenAI returned an invalid token lifetime");
  }

  return JSON.stringify({ access, expires, refresh });
}

async function exchangeCredential(
  runtime: OAuthRuntime,
  clientId: string,
  request: CredentialExchangeRequest,
): Promise<ConnectedAccountCredential> {
  const tokens = await postFormJson(
    runtime,
    OPENAI_TOKEN_URL,
    {
      client_id: clientId,
      code: request.code,
      code_verifier: request.verifier,
      grant_type: AUTHORIZATION_CODE_GRANT,
      redirect_uri: request.redirectUri,
    },
    "OpenAI rejected the authorization code",
  );
  const idToken = readProviderString(tokens, "id_token", "OpenAI");
  return {
    details: readOpenAiAccountDetails(idToken),
    secret: readTokenSecret(runtime, tokens),
  };
}

async function prepareCredential(
  runtime: OAuthRuntime,
  clientId: string,
  credential: ProviderCredentialAccess,
  force = false,
): Promise<string | undefined> {
  if (credential.source !== "oauth") {
    return undefined;
  }

  const stored = readOpenAiOAuthCredential(credential.secret);

  if (
    !force &&
    stored.expires > runtime.now() + TOKEN_REFRESH_LEEWAY_MILLISECONDS
  ) {
    return undefined;
  }

  const tokens = await postFormJson(
    runtime,
    OPENAI_TOKEN_URL,
    {
      client_id: clientId,
      grant_type: REFRESH_TOKEN_GRANT,
      refresh_token: stored.refresh,
    },
    "OpenAI rejected the refresh token",
    openAiRefreshReauthenticationError,
  );
  return readTokenSecret(runtime, tokens, stored.refresh);
}

function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string | null {
  const value = record[key];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} returned an invalid ${key}`);
  }

  return value;
}

function readJwtPayload(token: string): Readonly<Record<string, unknown>> {
  const parts = token.split(".");

  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0) ||
    parts[1] === undefined
  ) {
    throw new Error("OpenAI returned an invalid ID token");
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );

    if (isRecord(value)) {
      return value;
    }
  } catch {
    // The common error below deliberately avoids exposing token contents.
  }

  throw new Error("OpenAI returned an invalid ID token");
}

function readOpenAiAccountDetails(idToken: string): OpenAiAccountDetails {
  const claims = readJwtPayload(idToken);
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];
  const auth = isRecord(authClaim) ? authClaim : {};
  const profile = isRecord(profileClaim) ? profileClaim : {};
  const accountId =
    readOptionalString(auth, "chatgpt_account_id", "OpenAI") ??
    readOptionalString(claims, "chatgpt_account_id", "OpenAI");
  const email =
    readOptionalString(claims, "email", "OpenAI") ??
    readOptionalString(profile, "email", "OpenAI");

  return {
    accountId,
    label: email ?? accountId ?? "OpenAI account",
  };
}

async function readCredentialDetails(
  runtime: OAuthRuntime,
  apiKey: string,
): Promise<OpenAiAccountDetails> {
  const value = await readOpenAiApiKeyMetadata(runtime, apiKey);
  const accountId = readOptionalString(value, "id", "OpenAI");
  const name = readOptionalString(value, "name", "OpenAI");
  const email = readOptionalString(value, "email", "OpenAI");

  return {
    accountId,
    label: name ?? email ?? "OpenAI API key",
  };
}

export function createOpenAiIntegrationFromEnvironment(
  ...parameters: [
    environment: Readonly<Record<string, string | undefined>>,
    auth: GoogleAuth,
    dependencies?: OAuthDependencies,
  ]
): OpenAiIntegration {
  const [environment, auth, dependencies = {}] = parameters;
  const configuredClientId = normalizeOptionalValue(
    environment["OPENAI_CLIENT_ID"],
  );
  if (
    environment["OPENAI_CLIENT_ID"] !== undefined &&
    configuredClientId === undefined
  ) {
    throw new Error("OPENAI_CLIENT_ID cannot be empty");
  }

  const storage = readProviderIntegrationConfiguration(environment, {
    callbackPath: OPENAI_OAUTH_CALLBACK_PATH,
    credentialKeyVariable: "OPENAI_CREDENTIAL_KEY",
    missingKeyMessage:
      "OPENAI_CREDENTIAL_KEY must be set when OpenAI OAuth settings are set",
    redirectUriVariable: "OPENAI_REDIRECT_URI",
    settingsConfigured: configuredClientId !== undefined,
  });

  if (storage === undefined) {
    return createOpenAiIntegration(undefined, { auth, dependencies });
  }

  const clientId = configuredClientId ?? DEFAULT_OPENAI_CLIENT_ID;
  const configuration: OpenAiConfiguration = {
    ...storage,
    clientId,
    ...(storage.redirectUri === undefined &&
    clientId === DEFAULT_OPENAI_CLIENT_ID
      ? { redirectUri: OPENAI_LOOPBACK_REDIRECT_URI }
      : {}),
  };
  return createOpenAiIntegration(configuration, { auth, dependencies });
}

export function usesOpenAiLoopbackCallback(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const clientId =
    normalizeOptionalValue(environment["OPENAI_CLIENT_ID"]) ??
    DEFAULT_OPENAI_CLIENT_ID;
  return (
    normalizeOptionalValue(environment["OPENAI_CREDENTIAL_KEY"]) !==
      undefined &&
    normalizeOptionalValue(environment["OPENAI_REDIRECT_URI"]) === undefined &&
    clientId === DEFAULT_OPENAI_CLIENT_ID
  );
}

export function createOpenAiLoopbackCallbackHandler(
  integration: OpenAiIntegration,
  applicationUrl: string | URL,
): (request: Request) => Promise<Response> {
  const applicationBaseUrl = new URL(applicationUrl);

  return async (request) => {
    if (new URL(request.url).pathname !== OPENAI_LOOPBACK_CALLBACK_PATH) {
      return new Response("Not found", { status: 404 });
    }

    const response = await integration.complete(request);
    const location = response.headers.get("location");

    if (location === null) {
      return response;
    }

    const providerDestination = new URL(location);

    if (providerDestination.pathname !== APP_PATH) {
      return response;
    }

    const applicationDestination = new URL(APP_PATH, applicationBaseUrl);
    applicationDestination.search = providerDestination.search;
    applicationDestination.hash = providerDestination.hash;
    const headers = new Headers(response.headers);
    headers.set("location", applicationDestination.toString());
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function createOpenAiIntegration(
  configuration: OpenAiConfiguration | undefined,
  context: {
    readonly auth: GoogleAuth;
    readonly dependencies: OAuthDependencies;
  },
): OpenAiIntegration {
  const clientId = configuration?.clientId ?? DEFAULT_OPENAI_CLIENT_ID;
  return createProviderIntegration({
    auth: context.auth,
    configuration,
    createOAuthConfiguration: (runtime) => ({
      callbackPath: OPENAI_OAUTH_CALLBACK_PATH,
      createAuthorizationUrl: (request) =>
        createAuthorizationUrl(clientId, request),
      exchangeCredential: (request) =>
        exchangeCredential(runtime, clientId, request),
      flowCookies: OPENAI_FLOW_COOKIES,
      resultParameter: "openai",
      userCookie: "q_mush_openai_user",
      workspaceCookie: "q_mush_openai_workspace",
    }),
    dependencies: context.dependencies,
    prepareCredential: (runtime, credential, force) =>
      prepareCredential(runtime, clientId, credential, force),
    createQuotaReader: createOpenAiQuotaReader,
    createQuotaResetter: createCodexQuotaResetter,
    provider: "openai",
    readCredentialDetails,
  });
}
