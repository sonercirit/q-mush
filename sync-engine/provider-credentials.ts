import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import {
  DuplicateProviderCredentialError,
  type ProviderCredentialAccess,
  type ProviderCredentialDetails,
  type ProviderCredentialStore,
  type ProviderCredentialSummary,
} from "../shared/provider-credential-store.ts";
import {
  GLOBAL_WORKSPACE_ID,
  isWorkspaceId,
} from "../shared/workspace-model.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  createConfiguredAuthenticator,
  type Authenticate,
  type Authenticator,
} from "./authenticated-request.ts";
import { scopedCollectionForUser } from "./authenticated-scoped-collection.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import { readJsonRecord, type OAuthRuntime } from "./oauth.ts";
import { setOwnedDefault } from "./owned-default.ts";
import { updateAuthenticatedConnectionScopes } from "./scoped-collection.ts";

const API_KEY_MAXIMUM_LENGTH = 1024;
const API_KEY_LABEL_MAXIMUM_LENGTH = 100;

class InvalidProviderApiKeyError extends Error {
  constructor() {
    super("The provider rejected the API key");
    this.name = "InvalidProviderApiKeyError";
  }
}

function invalidApiKeyResponse(): Response {
  return createApiError("invalid_api_key", 400);
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
  readonly #authenticate: Authenticator;
  readonly #labelRequired: boolean;
  readonly #now: () => number;
  readonly #readCredentialDetails: (
    apiKey: string,
    label: string | undefined,
  ) => Promise<ProviderCredentialDetails>;
  readonly #store: ProviderCredentialStore | undefined;
  readonly #validateApiKey: (apiKey: string) => boolean;

  constructor(options: {
    readonly auth: GoogleAuth;
    readonly labelRequired?: boolean;
    readonly now: () => number;
    readonly readCredentialDetails: ReadCredentialDetails;
    readonly readLabeledCredentialDetails?: (
      apiKey: string,
      label: string,
    ) => Promise<ProviderCredentialDetails>;
    readonly store: ProviderCredentialStore | undefined;
    readonly validateApiKey?: (apiKey: string) => boolean;
  }) {
    this.#auth = options.auth;
    this.#authenticate = createConfiguredAuthenticator(
      options.auth,
      () => this.#store !== undefined,
    );
    this.#labelRequired = options.labelRequired ?? false;
    this.#now = options.now;
    const readLabeledDetails = options.readLabeledCredentialDetails;
    if (readLabeledDetails !== undefined) {
      this.#readCredentialDetails = (apiKey, label) => {
        if (label === undefined) {
          return Promise.reject(new Error("The credential label is required"));
        }

        return readLabeledDetails(apiKey, label);
      };
    } else {
      this.#readCredentialDetails = (apiKey) =>
        options.readCredentialDetails(apiKey);
    }
    this.#store = options.store;
    this.#validateApiKey = options.validateApiKey ?? (() => true);
  }

  authorize: Authenticate = (request, action) =>
    this.#authenticate.authenticate(request, action);

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
    return scopedCollectionForUser({
      create: () => this.#createCredential(request, user),
      key: "credentials",
      read: (userId, workspaceId) =>
        this.#credentialStore().list(userId, workspaceId),
      request,
      user,
      validate: (userId, workspaceId) =>
        this.validateScopes(userId, [workspaceId]),
    });
  }

  async #createCredential(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    const supplied = await parseJsonRequest(request, (value) => {
      if (!isRecord(value)) {
        return undefined;
      }

      const apiKey = value["apiKey"];
      const label = value["label"];
      const workspaceIds = value["workspaceIds"];

      if (
        typeof apiKey !== "string" ||
        (label !== undefined && typeof label !== "string") ||
        (workspaceIds !== undefined &&
          (!Array.isArray(workspaceIds) ||
            workspaceIds.length === 0 ||
            !workspaceIds.every(isWorkspaceId)))
      ) {
        return undefined;
      }

      const normalizedLabel = label?.trim();

      if (
        (this.#labelRequired && normalizedLabel === undefined) ||
        normalizedLabel?.length === 0 ||
        (normalizedLabel?.length ?? 0) > API_KEY_LABEL_MAXIMUM_LENGTH
      ) {
        return undefined;
      }

      return {
        apiKey,
        label: normalizedLabel,
        workspaceIds:
          workspaceIds === undefined ? undefined : workspaceIds.map(String),
      };
    });

    if (supplied === undefined) {
      return createApiError("invalid_request", 400);
    }

    const apiKey = supplied.apiKey.trim();

    if (
      apiKey.length === 0 ||
      apiKey.length > API_KEY_MAXIMUM_LENGTH ||
      /\s/u.test(apiKey) ||
      !this.#validateApiKey(apiKey)
    ) {
      return invalidApiKeyResponse();
    }

    const workspaceIds = supplied.workspaceIds ?? [GLOBAL_WORKSPACE_ID];
    if (!this.validateScopes(user.id, workspaceIds)) {
      return createApiError("invalid_scope", 409);
    }

    try {
      const details = await this.#readCredentialDetails(apiKey, supplied.label);
      const credential = this.#credentialStore().add(
        user.id,
        apiKey,
        details,
        "api_key",
        this.#now(),
        workspaceIds,
      );
      return createJsonResponse(credential, 201);
    } catch (error) {
      if (error instanceof InvalidProviderApiKeyError) {
        return invalidApiKeyResponse();
      }

      if (error instanceof DuplicateProviderCredentialError) {
        return createApiError("credential_exists", 409);
      }

      return createApiError("provider_unavailable", 502);
    }
  }

  readCredential(
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ): ProviderCredentialAccess | undefined {
    return this.#store?.read(userId, credentialId, workspaceId);
  }

  validateScopes(userId: string, workspaceIds: readonly string[]): boolean {
    try {
      this.#credentialStore().validateScopes(userId, workspaceIds);
      return true;
    } catch {
      return false;
    }
  }

  updateCredentialSecret(
    userId: string,
    credentialId: string,
    secret: string,
    now: number,
  ): void {
    if (this.#store?.updateSecret(userId, credentialId, secret, now) !== true) {
      throw new Error("The provider credential is no longer available");
    }
  }

  addConnectedAccount(
    user: AuthenticatedUser,
    secret: string,
    details: ProviderCredentialDetails,
    workspaceIds: readonly string[] = [GLOBAL_WORKSPACE_ID],
  ): ProviderCredentialSummary {
    return this.#credentialStore().add(
      user.id,
      secret,
      details,
      "oauth",
      this.#now(),
      workspaceIds,
    );
  }

  setDefault(request: Request, credentialId: string): Response {
    const change = (userId: string): boolean =>
      this.#credentialStore().setDefault(userId, credentialId, this.#now());
    return setOwnedDefault(request, this.#auth, change);
  }

  async setScopes(request: Request, credentialId: string): Promise<Response> {
    return updateAuthenticatedConnectionScopes(
      request,
      (action) => this.authorize(request, action),
      (userId, workspaceIds) =>
        this.#credentialStore().setScopes(
          userId,
          credentialId,
          workspaceIds,
          this.#now(),
        ),
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
      return createNoContentResponse();
    }

    return createApiError("not_found", 404);
  }

  #credentialStore(): ProviderCredentialStore {
    if (this.#store === undefined) {
      throw new Error("Provider credential storage is not configured");
    }

    return this.#store;
  }
}
