import { isRecord, type AuthenticatedUser } from "./auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { createJsonResponse, createMethodNotAllowedResponse } from "./http.ts";
import { readJsonRecord, type OAuthRuntime } from "./oauth.ts";
import {
  DuplicateProviderCredentialError,
  type ProviderCredentialDetails,
  type ProviderCredentialStore,
  type ProviderCredentialSummary,
} from "./provider-credential-store.ts";

const API_KEY_MAXIMUM_LENGTH = 1024;

class InvalidProviderApiKeyError extends Error {
  constructor() {
    super("The provider rejected the API key");
    this.name = "InvalidProviderApiKeyError";
  }
}

export function createApiKeyMetadataReader(
  url: string,
  errorMessage: string,
): (
  runtime: OAuthRuntime,
  apiKey: string,
) => Promise<Readonly<Record<string, unknown>>> {
  return (runtime, apiKey) =>
    readApiKeyMetadata(runtime, url, apiKey, errorMessage);
}

async function readApiKeyMetadata(
  runtime: OAuthRuntime,
  url: string,
  apiKey: string,
  errorMessage: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await runtime.fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new InvalidProviderApiKeyError();
  }

  return readJsonRecord(response, errorMessage);
}

export type ReadCredentialDetails = (
  apiKey: string,
) => Promise<ProviderCredentialDetails>;

export class ProviderCredentialEndpoints {
  readonly #auth: GoogleAuth;
  readonly #now: () => number;
  readonly #readCredentialDetails: ReadCredentialDetails;
  readonly #store: ProviderCredentialStore | undefined;

  constructor(options: {
    readonly auth: GoogleAuth;
    readonly now: () => number;
    readonly readCredentialDetails: ReadCredentialDetails;
    readonly store: ProviderCredentialStore | undefined;
  }) {
    this.#auth = options.auth;
    this.#now = options.now;
    this.#readCredentialDetails = options.readCredentialDetails;
    this.#store = options.store;
  }

  authorize<T extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => T,
  ): Response | T {
    const user = this.#auth.authenticatedUser(request);

    if (user === null) {
      return createJsonResponse({ error: "authentication_required" }, 401);
    }

    return this.#store === undefined
      ? createJsonResponse({ error: "not_configured" }, 503)
      : action(user);
  }

  credentials(request: Request): Promise<Response> {
    return Promise.resolve(
      this.authorize(request, (user) =>
        this.#credentialsAuthorized(request, user),
      ),
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

    if (
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json") !== true
    ) {
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
        this.#now(),
      );
      return createJsonResponse(credential, 201);
    } catch (error) {
      if (error instanceof InvalidProviderApiKeyError) {
        return createJsonResponse({ error: "invalid_api_key" }, 400);
      }

      if (error instanceof DuplicateProviderCredentialError) {
        return createJsonResponse({ error: "credential_exists" }, 409);
      }

      return createJsonResponse({ error: "provider_unavailable" }, 502);
    }
  }

  addConnectedAccount(
    user: AuthenticatedUser,
    secret: string,
    details: ProviderCredentialDetails,
  ): ProviderCredentialSummary {
    return this.#credentialStore().add(
      user.id,
      secret,
      details,
      "oauth",
      this.#now(),
    );
  }

  remove(request: Request, credentialId: string): Response {
    if (request.method !== "DELETE") {
      return createMethodNotAllowedResponse("DELETE");
    }

    return this.authorize(request, (user) =>
      this.#removeAuthorized(user, credentialId),
    );
  }

  #removeAuthorized(user: AuthenticatedUser, credentialId: string): Response {
    if (this.#credentialStore().remove(user.id, credentialId, this.#now())) {
      return new Response(null, {
        headers: { "cache-control": "no-store" },
        status: 204,
      });
    }

    return createJsonResponse({ error: "not_found" }, 404);
  }

  #credentialStore(): ProviderCredentialStore {
    if (this.#store === undefined) {
      throw new Error("Provider credential storage is not configured");
    }

    return this.#store;
  }
}
