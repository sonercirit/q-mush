import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialDetails } from "../shared/provider-credential-store.ts";
import { APP_PATH } from "../shared/routes.ts";
import {
  GLOBAL_WORKSPACE_ID,
  isWorkspaceId,
} from "../shared/workspace-model.ts";
import {
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
  readonly flowCookies: FlowCookies;
  readonly redirectUri?: string;
  readonly resultParameter: string;
  readonly userCookie: string;
  readonly workspaceCookie: string;
}

export interface ConnectedAccountCredentialWriter {
  addConnectedAccount(
    user: AuthenticatedUser,
    secret: string,
    details: ProviderCredentialDetails,
    workspaceIds: readonly string[],
  ): unknown;
  authorize<T extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => T,
  ): Response | T;
  validateScopes(userId: string, workspaceIds: readonly string[]): boolean;
}

export class ConnectedAccountOAuth {
  readonly #configuration: ConnectedAccountOAuthConfiguration;
  readonly #credentials: ConnectedAccountCredentialWriter;
  readonly #runtime: OAuthRuntime;

  constructor(
    configuration: ConnectedAccountOAuthConfiguration,
    credentials: ConnectedAccountCredentialWriter,
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
    const requestedWorkspaceId = new URL(request.url).searchParams.get(
      "workspaceId",
    );
    const workspaceId = requestedWorkspaceId ?? GLOBAL_WORKSPACE_ID;
    if (
      !isWorkspaceId(workspaceId) ||
      !this.#credentials.validateScopes(user.id, [workspaceId])
    ) {
      return new Response("Invalid workspace scope", { status: 409 });
    }
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
      createCookie(
        this.#configuration.userCookie,
        "",
        0,
        this.#configuration.flowCookies.path,
        secure,
      ),
      createCookie(
        this.#configuration.workspaceCookie,
        "",
        0,
        this.#configuration.flowCookies.path,
        secure,
      ),
    ];
    const callback = readOAuthCallback(
      request,
      this.#configuration.flowCookies,
    );

    switch (callback.status) {
      case "ready":
        break;
      case "denied":
      case "failed":
      case "invalid_state":
        return this.#appRedirect(request, callback.status, clearedCookies);
    }

    const flowUserId = readCookie(request, this.#configuration.userCookie);

    if (flowUserId === undefined || !valuesMatch(flowUserId, user.id)) {
      return this.#appRedirect(request, "invalid_state", clearedCookies);
    }

    const workspaceId = readCookie(
      request,
      this.#configuration.workspaceCookie,
    );
    if (
      workspaceId === undefined ||
      !isWorkspaceId(workspaceId) ||
      !this.#credentials.validateScopes(user.id, [workspaceId])
    ) {
      return this.#appRedirect(request, "invalid_state", clearedCookies);
    }

    try {
      const credential = await this.#configuration.exchangeCredential({
        code: callback.code,
        redirectUri,
        verifier: callback.verifier,
      });
      this.#credentials.addConnectedAccount(
        user,
        credential.secret,
        credential.details,
        [workspaceId],
      );
      return this.#appRedirect(request, "connected", clearedCookies);
    } catch {
      return this.#appRedirect(request, "failed", clearedCookies);
    }
  }

  #appRedirect(
    request: Request,
    result: "connected" | "denied" | "failed" | "invalid_state",
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
