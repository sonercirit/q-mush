import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialDetails } from "../shared/provider-credential-store.ts";
import { APP_PATH } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import {
  createApiError,
  createCookie,
  createMethodNotAllowedResponse,
  createRedirect,
  readCookie,
  valuesMatch,
} from "./http.ts";
import {
  clearPkceCookies,
  createFlowCookie,
  readOAuthCallback,
  redirectToApp,
  resolveRedirectUri,
  startPkceFlowForRedirect,
  usesSecureCookies,
  type FlowCookies,
  type OAuthRuntime,
} from "./oauth.ts";
import type { ProviderCredentialEndpoints } from "./provider-credentials.ts";
import { workspaceScopeIsValid } from "./workspace-scope.ts";

export interface AuthorizationRequest {
  readonly callbackUri: string;
  readonly challenge: string;
  readonly state: string;
}

export interface CredentialExchangeRequest {
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
}

export interface ConnectedAccountCredential {
  readonly details: ProviderCredentialDetails;
  readonly secret: string;
}

export interface ConnectedAccountOAuthConfiguration {
  readonly callbackPath: string;
  readonly createAuthorizationUrl: (request: AuthorizationRequest) => URL;
  readonly exchangeCredential: (
    request: CredentialExchangeRequest,
  ) => Promise<ConnectedAccountCredential>;
  readonly credentialCookie: string;
  readonly flowCookies: FlowCookies;
  readonly redirectUri?: string;
  readonly resultParameter: string;
  readonly userCookie: string;
  readonly workspaceCookie: string;
}

export class ConnectedAccountOAuth {
  readonly #configuration: ConnectedAccountOAuthConfiguration;
  readonly #credentials: ProviderCredentialEndpoints;
  readonly #runtime: OAuthRuntime;

  constructor(
    configuration: ConnectedAccountOAuthConfiguration,
    credentials: ProviderCredentialEndpoints,
    runtime: OAuthRuntime,
  ) {
    this.#configuration = configuration;
    this.#credentials = credentials;
    this.#runtime = runtime;
  }

  begin(request: Request): Response {
    if (["GET"].includes(request.method)) {
      return this.#credentials.authorize(request, (user) =>
        this.#beginAuthorized(request, user),
      );
    }

    return createMethodNotAllowedResponse("GET");
  }

  #validWorkspaceScope(
    workspaceId: string | undefined,
    userId: string,
  ): workspaceId is string {
    return workspaceScopeIsValid(workspaceId, userId, (ownerId, workspaceIds) =>
      this.#credentials.validateScopes(ownerId, workspaceIds),
    );
  }

  #beginAuthorized(request: Request, user: AuthenticatedUser): Response {
    const redirectUri = this.#redirectUri(request);
    const { challenge, cookies, secure, state } = startPkceFlowForRedirect(
      this.#runtime,
      this.#configuration.flowCookies,
      redirectUri,
    );
    const authorizationUrl = this.#configuration.createAuthorizationUrl({
      callbackUri: redirectUri,
      challenge,
      state,
    });
    const userCookie = createFlowCookie(
      this.#configuration.userCookie,
      user.id,
      this.#configuration.flowCookies.path,
      secure,
    );

    const requestUrl = new URL(request.url);
    const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId");
    const workspaceId = requestedWorkspaceId ?? GLOBAL_WORKSPACE_ID;
    if (!this.#validWorkspaceScope(workspaceId, user.id)) {
      return createApiError("invalid_workspace_scope", 409);
    }
    const requestedCredentialId = requestUrl.searchParams.get("credentialId");
    if (
      requestedCredentialId !== null &&
      this.#credentials.readCredentialMetadata(
        user.id,
        requestedCredentialId,
        workspaceId,
      )?.requiresReauthentication !== true
    ) {
      return createApiError("invalid_credential", 409);
    }
    const credentialCookie = createFlowCookie(
      this.#configuration.credentialCookie,
      requestedCredentialId ?? "",
      this.#configuration.flowCookies.path,
      secure,
    );

    const workspaceCookie = createFlowCookie(
      this.#configuration.workspaceCookie,
      workspaceId,
      this.#configuration.flowCookies.path,
      secure,
    );

    return createRedirect(authorizationUrl, [
      ...cookies,
      userCookie,
      workspaceCookie,
      credentialCookie,
    ]);
  }

  async complete(request: Request): Promise<Response> {
    if (!["GET"].includes(request.method)) {
      return createMethodNotAllowedResponse("GET");
    }

    return await this.#credentials.authorize(request, (user) =>
      this.#completeAuthorized(request, user),
    );
  }

  async #completeAuthorized(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    const redirectUri = this.#redirectUri(request);
    const secure = usesSecureCookies(redirectUri);
    const clearedCookies = [
      ...clearPkceCookies(this.#configuration.flowCookies, secure),
      ...[
        this.#configuration.userCookie,
        this.#configuration.credentialCookie,
        this.#configuration.workspaceCookie,
      ].map((name) =>
        createCookie(name, "", 0, this.#configuration.flowCookies.path, secure),
      ),
    ];
    const callback = readOAuthCallback(
      request,
      this.#configuration.flowCookies,
    );

    if (callback.status !== "ready") {
      return this.#appRedirect(request, callback.status, clearedCookies);
    }

    const invalidState = (): Response =>
      this.#appRedirect(request, "invalid_state", clearedCookies);
    const flowUserId = readCookie(request, this.#configuration.userCookie);
    const workspaceId = readCookie(
      request,
      this.#configuration.workspaceCookie,
    );
    const credentialId = readCookie(
      request,
      this.#configuration.credentialCookie,
    );
    if (
      flowUserId === undefined ||
      !valuesMatch(flowUserId, user.id) ||
      !this.#validWorkspaceScope(workspaceId, user.id)
    ) {
      return invalidState();
    }

    try {
      const credential = await this.#configuration.exchangeCredential({
        code: callback.code,
        redirectUri,
        verifier: callback.verifier,
      });
      const isNewCredential =
        credentialId === undefined || credentialId.length === 0;
      const reconnecting = isNewCredential
        ? undefined
        : this.#credentials.readCredentialMetadata(
            user.id,
            credentialId,
            workspaceId,
          );
      if (isNewCredential) {
        this.#credentials.addConnectedAccount(
          user,
          credential.secret,
          credential.details,
          [workspaceId],
        );
      } else if (
        reconnecting?.requiresReauthentication !== true ||
        reconnecting.accountId !== credential.details.accountId ||
        !this.#credentials.reconnectCredential(
          user.id,
          credentialId,
          credential.secret,
          this.#runtime.now(),
          credential.details,
        )
      ) {
        return this.#appRedirect(request, "wrong_account", clearedCookies);
      }
      return this.#appRedirect(request, "connected", clearedCookies);
    } catch (error) {
      return this.#appRedirect(
        request,
        error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
          ? "credential_conflict"
          : "failed",
        clearedCookies,
      );
    }
  }

  #appRedirect(
    request: Request,
    result:
      | "connected"
      | "credential_conflict"
      | "denied"
      | "failed"
      | "invalid_state"
      | "wrong_account",
    cookies: readonly string[],
  ): Response {
    return redirectToApp(
      APP_PATH,
      this.#redirectUri(request),
      this.#configuration.resultParameter,
      result,
      cookies,
    );
  }

  #redirectUri(request: Request): string {
    return resolveRedirectUri(
      this.#configuration.redirectUri,
      this.#configuration.callbackPath,
      request,
    );
  }
}
