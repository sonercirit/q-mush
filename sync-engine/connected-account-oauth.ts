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

export interface ConnectedAccountOAuth {
  begin(request: Request): Response;
  complete(request: Request): Promise<Response>;
}

export function createConnectedAccountOAuth(
  configuration: ConnectedAccountOAuthConfiguration,
  credentials: ProviderCredentialEndpoints,
  runtime: OAuthRuntime,
): ConnectedAccountOAuth {

  const begin = (request: Request): Response => {
    if (["GET"].includes(request.method)) {
      return credentials.authorize(request, (user) =>
        beginAuthorized(request, user),
      );
    }

    return createMethodNotAllowedResponse("GET");
  };

  const validWorkspaceScope = (
    workspaceId: string | undefined,
    userId: string,
  ): workspaceId is string => {
    return workspaceScopeIsValid(workspaceId, userId, (ownerId, workspaceIds) =>
      credentials.validateScopes(ownerId, workspaceIds),
    );
  };

  const beginAuthorized = (request: Request, user: AuthenticatedUser): Response => {
    const callbackUri = redirectUri(request);
    const { challenge, cookies, secure, state } = startPkceFlowForRedirect(
      runtime,
      configuration.flowCookies,
      callbackUri,
    );
    const authorizationUrl = configuration.createAuthorizationUrl({
      callbackUri,
      challenge,
      state,
    });
    const userCookie = createFlowCookie(
      configuration.userCookie,
      user.id,
      configuration.flowCookies.path,
      secure,
    );

    const requestUrl = new URL(request.url);
    const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId");
    const workspaceId = requestedWorkspaceId ?? GLOBAL_WORKSPACE_ID;
    if (!validWorkspaceScope(workspaceId, user.id)) {
      return createApiError("invalid_workspace_scope", 409);
    }
    const requestedCredentialId = requestUrl.searchParams.get("credentialId");
    if (
      requestedCredentialId !== null &&
      credentials.readCredentialMetadata(
        user.id,
        requestedCredentialId,
        workspaceId,
      )?.requiresReauthentication !== true
    ) {
      return createApiError("invalid_credential", 409);
    }
    const credentialCookie = createFlowCookie(
      configuration.credentialCookie,
      requestedCredentialId ?? "",
      configuration.flowCookies.path,
      secure,
    );

    const workspaceCookie = createFlowCookie(
      configuration.workspaceCookie,
      workspaceId,
      configuration.flowCookies.path,
      secure,
    );

    return createRedirect(authorizationUrl, [
      ...cookies,
      userCookie,
      workspaceCookie,
      credentialCookie,
    ]);
  };

  const complete = async (request: Request): Promise<Response> => {
    if (!["GET"].includes(request.method)) {
      return createMethodNotAllowedResponse("GET");
    }

    return await credentials.authorize(request, (user) =>
      completeAuthorized(request, user),
    );
  };

  const completeAuthorized = async (
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> => {
    const callbackUri = redirectUri(request);
    const secure = usesSecureCookies(callbackUri);
    const clearedCookies = [
      ...clearPkceCookies(configuration.flowCookies, secure),
      ...[
        configuration.userCookie,
        configuration.credentialCookie,
        configuration.workspaceCookie,
      ].map((name) =>
        createCookie(name, "", 0, configuration.flowCookies.path, secure),
      ),
    ];
    const callback = readOAuthCallback(
      request,
      configuration.flowCookies,
    );

    if (callback.status !== "ready") {
      return appRedirect(request, callback.status, clearedCookies);
    }

    const invalidState = (): Response =>
      appRedirect(request, "invalid_state", clearedCookies);
    const flowUserId = readCookie(request, configuration.userCookie);
    const workspaceId = readCookie(
      request,
      configuration.workspaceCookie,
    );
    const credentialId = readCookie(
      request,
      configuration.credentialCookie,
    );
    if (
      flowUserId === undefined ||
      !valuesMatch(flowUserId, user.id) ||
      !validWorkspaceScope(workspaceId, user.id)
    ) {
      return invalidState();
    }

    try {
      const credential = await configuration.exchangeCredential({
        code: callback.code,
        redirectUri: callbackUri,
        verifier: callback.verifier,
      });
      const isNewCredential =
        credentialId === undefined || credentialId.length === 0;
      const reconnecting = isNewCredential
        ? undefined
        : credentials.readCredentialMetadata(
            user.id,
            credentialId,
            workspaceId,
          );
      if (isNewCredential) {
        credentials.addConnectedAccount(
          user,
          credential.secret,
          credential.details,
          [workspaceId],
        );
      } else if (
        reconnecting?.requiresReauthentication !== true ||
        reconnecting.accountId !== credential.details.accountId ||
        !credentials.reconnectCredential(
          user.id,
          credentialId,
          credential.secret,
          runtime.now(),
          credential.details,
        )
      ) {
        return appRedirect(request, "wrong_account", clearedCookies);
      }
      return appRedirect(request, "connected", clearedCookies);
    } catch (error) {
      return appRedirect(
        request,
        error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
          ? "credential_conflict"
          : "failed",
        clearedCookies,
      );
    }
  };

  const appRedirect = (
    request: Request,
    result:
      | "connected"
      | "credential_conflict"
      | "denied"
      | "failed"
      | "invalid_state"
      | "wrong_account",
    cookies: readonly string[],
  ): Response => {
    return redirectToApp(
      APP_PATH,
      redirectUri(request),
      configuration.resultParameter,
      result,
      cookies,
    );
  };

  const redirectUri = (request: Request): string => {
    return resolveRedirectUri(
      configuration.redirectUri,
      configuration.callbackPath,
      request,
    );
  };
  return { begin, complete };
}
