import { isRecord, type AuthenticatedUser } from "./auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  createCredentialCipher,
  type CredentialCipher,
} from "./credential-cipher.ts";
import {
  createCookie,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createRedirect,
  readCookie,
  valuesMatch,
} from "./http.ts";
import * as oauth from "./oauth.ts";
import {
  DuplicateOpenRouterCredentialError,
  OpenRouterCredentialStore,
  type OpenRouterCredentialDetails,
} from "./openrouter-store.ts";
import {
  APP_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
} from "./routes.ts";

const OPENROUTER_AUTHORIZATION_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEY_METADATA_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const OAUTH_USER_COOKIE = "q_mush_openrouter_user";
const API_KEY_MAXIMUM_LENGTH = 1024;
const OPENROUTER_FLOW_COOKIES: oauth.FlowCookies = {
  path: OPENROUTER_OAUTH_PATH,
  state: "q_mush_openrouter_state",
  verifier: "q_mush_openrouter_verifier",
};

interface OpenRouterConfiguration {
  readonly cipher: CredentialCipher;
  readonly redirectUri?: string;
}

interface ExchangedCredential {
  readonly apiKey: string;
  readonly accountId: string | null;
}

class InvalidApiKeyError extends Error {}

export interface OpenRouterIntegration extends oauth.OAuthEndpoints {
  credentials(request: Request): Promise<Response>;
  remove(request: Request, credentialId: string): Response;
}

function createUnauthorizedResponse(): Response {
  return createJsonResponse({ error: "authentication_required" }, 401);
}

function createUnavailableResponse(): Response {
  return createJsonResponse({ error: "not_configured" }, 503);
}

class OpenRouterConnection implements OpenRouterIntegration {
  readonly #auth: GoogleAuth;
  readonly #configuration: OpenRouterConfiguration | undefined;
  readonly #runtime: oauth.OAuthRuntime;
  readonly #store: OpenRouterCredentialStore | undefined;

  constructor(
    configuration: OpenRouterConfiguration | undefined,
    auth: GoogleAuth,
    dependencies: oauth.OAuthDependencies,
  ) {
    this.#auth = auth;
    this.#configuration = configuration;
    this.#runtime = oauth.createOAuthRuntime(dependencies);
    this.#store = undefined;

    if (configuration !== undefined) {
      this.#store = new OpenRouterCredentialStore(
        this.#runtime.database,
        configuration.cipher,
        this.#runtime.generateId,
      );
    }
  }

  begin(request: Request): Response {
    if (request.method === "GET") {
      return this.#authorize(request, (user) =>
        this.#beginAuthorized(request, user),
      );
    }

    return createMethodNotAllowedResponse("GET");
  }

  #beginAuthorized(request: Request, user: AuthenticatedUser): Response {
    const callbackUrl = new URL(this.#redirectUri(request));
    const secure = callbackUrl.protocol === "https:";
    const flow = oauth.startPkceFlow(
      this.#runtime,
      OPENROUTER_FLOW_COOKIES,
      secure,
    );
    callbackUrl.searchParams.set("state", flow.state);
    const authorizationUrl = new URL(OPENROUTER_AUTHORIZATION_URL);
    authorizationUrl.search = new URLSearchParams({
      callback_url: callbackUrl.toString(),
      code_challenge: flow.challenge,
      code_challenge_method: "S256",
    }).toString();
    const userCookie = oauth.createFlowCookie(
      OAUTH_USER_COOKIE,
      user.id,
      OPENROUTER_FLOW_COOKIES.path,
      secure,
    );

    const responseCookies = [...flow.cookies, userCookie];
    return createRedirect(authorizationUrl, responseCookies);
  }

  async complete(request: Request): Promise<Response> {
    switch (request.method) {
      case "GET":
        return this.#authorize(request, (user) =>
          this.#completeAuthorized(request, user),
        );
      default:
        return createMethodNotAllowedResponse("GET");
    }
  }

  async #completeAuthorized(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    const secure = new URL(this.#redirectUri(request)).protocol === "https:";
    const clearedCookies = [
      ...oauth.clearPkceCookies(OPENROUTER_FLOW_COOKIES, secure),
      createCookie(
        OAUTH_USER_COOKIE,
        "",
        0,
        OPENROUTER_FLOW_COOKIES.path,
        secure,
      ),
    ];
    const callback = oauth.readOAuthCallback(request, OPENROUTER_FLOW_COOKIES);

    switch (callback.status) {
      case "ready":
        break;
      case "denied":
      case "failed":
      case "invalid_state":
        return this.#appRedirect(request, callback.status, clearedCookies);
    }

    const flowUserId = readCookie(request, OAUTH_USER_COOKIE);

    if (flowUserId === undefined || !valuesMatch(flowUserId, user.id)) {
      return this.#appRedirect(request, "invalid_state", clearedCookies);
    }

    try {
      const exchanged = await this.#exchangeCode(
        callback.code,
        callback.verifier,
      );

      this.#credentialStore().add(
        user.id,
        exchanged.apiKey,
        {
          accountId: exchanged.accountId,
          label: "OpenRouter account",
        },
        "oauth",
        this.#runtime.now(),
      );

      return this.#appRedirect(request, "connected", clearedCookies);
    } catch {
      return this.#appRedirect(request, "failed", clearedCookies);
    }
  }

  async credentials(request: Request): Promise<Response> {
    return this.#authorize(request, (user) =>
      this.#credentialsAuthorized(request, user),
    );
  }

  async #credentialsAuthorized(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    if (request.method === "GET") {
      return createJsonResponse({
        credentials: this.#credentialStore().list(user.id),
      });
    }

    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("GET, POST");
    }

    const contentType = request.headers.get("content-type")?.toLowerCase();

    if (contentType?.startsWith("application/json") !== true) {
      return createJsonResponse({ error: "invalid_request" }, 400);
    }

    let value: unknown;

    try {
      value = await request.json();
    } catch {
      return createJsonResponse({ error: "invalid_request" }, 400);
    }

    if (!isRecord(value) || typeof value["apiKey"] !== "string") {
      return createJsonResponse({ error: "invalid_request" }, 400);
    }

    const apiKey = value["apiKey"].trim();

    if (
      apiKey.length === 0 ||
      apiKey.length > API_KEY_MAXIMUM_LENGTH ||
      /\s/u.test(apiKey)
    ) {
      return createJsonResponse({ error: "invalid_api_key" }, 400);
    }

    try {
      const details = await this.#readCredentialDetails(apiKey);
      const credential = this.#credentialStore().add(
        user.id,
        apiKey,
        details,
        "api_key",
        this.#runtime.now(),
      );
      return createJsonResponse(credential, 201);
    } catch (error) {
      if (error instanceof InvalidApiKeyError) {
        return createJsonResponse({ error: "invalid_api_key" }, 400);
      }

      if (error instanceof DuplicateOpenRouterCredentialError) {
        return createJsonResponse({ error: "credential_exists" }, 409);
      }

      return createJsonResponse({ error: "provider_unavailable" }, 502);
    }
  }

  remove(request: Request, credentialId: string): Response {
    if (request.method !== "DELETE") {
      return createMethodNotAllowedResponse("DELETE");
    }

    return this.#authorize(request, (user) =>
      this.#removeAuthorized(user, credentialId),
    );
  }

  #removeAuthorized(user: AuthenticatedUser, credentialId: string): Response {
    if (
      this.#credentialStore().remove(user.id, credentialId, this.#runtime.now())
    ) {
      return new Response(null, {
        headers: { "cache-control": "no-store" },
        status: 204,
      });
    }

    return createJsonResponse({ error: "not_found" }, 404);
  }

  #authorize<T extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => T,
  ): Response | T {
    const user = this.#auth.authenticatedUser(request);

    if (user === null) {
      return createUnauthorizedResponse();
    }

    return this.#configuration === undefined
      ? createUnavailableResponse()
      : action(user);
  }

  #appRedirect(
    request: Request,
    result: "connected" | "denied" | "failed" | "invalid_state",
    cookies: readonly string[],
  ): Response {
    return oauth.redirectToApp(
      APP_PATH,
      this.#redirectUri(request),
      "openrouter",
      result,
      cookies,
    );
  }

  #credentialStore(): OpenRouterCredentialStore {
    if (this.#store === undefined) {
      throw new Error("OpenRouter credential storage is not configured");
    }

    return this.#store;
  }

  async #exchangeCode(
    code: string,
    verifier: string,
  ): Promise<ExchangedCredential> {
    const response = await this.#runtime.fetch(OPENROUTER_TOKEN_URL, {
      body: JSON.stringify({
        code,
        code_challenge_method: "S256",
        code_verifier: verifier,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    });

    const value = await oauth.readJsonRecord(
      response,
      "OpenRouter rejected the authorization code",
    );
    return {
      accountId: oauth.readProviderUserId({
        key: "user_id",
        provider: "OpenRouter",
        record: value,
      }),
      apiKey: oauth.readProviderString(value, "key", "OpenRouter"),
    };
  }

  async #readCredentialDetails(
    apiKey: string,
  ): Promise<OpenRouterCredentialDetails> {
    const response = await this.#runtime.fetch(OPENROUTER_KEY_METADATA_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError();
    }

    const value = await oauth.readJsonRecord(
      response,
      "OpenRouter could not validate the API key",
    );
    const data = value["data"];

    if (!isRecord(data)) {
      throw new Error("OpenRouter returned invalid API key metadata");
    }
    return {
      accountId: oauth.readProviderUserId({
        key: "creator_user_id",
        provider: "OpenRouter",
        record: data,
      }),
      label: oauth.readProviderString(data, "label", "OpenRouter"),
    };
  }

  #redirectUri(request: Request): string {
    return oauth.resolveRedirectUri(
      this.#configuration?.redirectUri,
      OPENROUTER_OAUTH_CALLBACK_PATH,
      request,
    );
  }
}

export function createOpenRouterIntegrationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  auth: GoogleAuth,
  dependencies: oauth.OAuthDependencies = {},
): OpenRouterIntegration {
  const encodedCredentialKey = oauth.normalizeOptionalValue(
    environment["OPENROUTER_CREDENTIAL_KEY"],
  );
  const redirectUri = oauth.normalizeOptionalValue(
    environment["OPENROUTER_REDIRECT_URI"],
  );

  if (encodedCredentialKey === undefined) {
    if (redirectUri !== undefined) {
      throw new Error(
        "OPENROUTER_CREDENTIAL_KEY must be set when OPENROUTER_REDIRECT_URI is set",
      );
    }

    return new OpenRouterConnection(undefined, auth, dependencies);
  }

  const configuration: OpenRouterConfiguration = {
    cipher: createCredentialCipher(encodedCredentialKey),
    ...(redirectUri === undefined
      ? {}
      : {
          redirectUri: oauth.validateRedirectUri(
            redirectUri,
            OPENROUTER_OAUTH_CALLBACK_PATH,
            "OPENROUTER_REDIRECT_URI",
          ),
        }),
  };
  return new OpenRouterConnection(configuration, auth, dependencies);
}
