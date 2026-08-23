import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import {
  APP_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
} from "../shared/routes.ts";
import { createDrizzleAuthStore, type GoogleUserProfile } from "./auth-store.ts";
import {
  appendCookies,
  createCookie,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createRedirect,
  readCookie,
} from "./http.ts";
import {
  clearPkceCookies,
  createOAuthRuntime,
  generateOAuthToken,
  normalizeOptionalValue,
  postFormJson,
  readJsonRecord,
  readOAuthCallback,
  readProviderString,
  redirectToApp,
  resolveRedirectUri,
  startPkceFlowForRedirect,
  usesSecureCookies,
  validateRedirectUri,
  type FlowCookies,
  type OAuthDependencies,
  type OAuthEndpoints,
} from "./oauth.ts";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SESSION_COOKIE = "q_mush_session";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const GOOGLE_FLOW_COOKIES: FlowCookies = {
  path: AUTH_GOOGLE_PATH,
  state: "q_mush_oauth_state",
  verifier: "q_mush_oauth_verifier",
};

interface GoogleAuthConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri?: string;
}

export interface GoogleAuth extends OAuthEndpoints {
  authenticatedUser(request: Request): AuthenticatedUser | null;
  revalidateUser(
    request: Request,
    expectedUserId: string,
  ): AuthenticatedUser | null;
  logout(request: Request): Response;
  session(request: Request): Response;
}

function normalizeConfiguration(
  configuration: GoogleAuthConfiguration,
): GoogleAuthConfiguration {
  const clientId = configuration.clientId.trim();
  const clientSecret = configuration.clientSecret.trim();

  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error("Google OAuth credentials cannot be empty");
  }

  return configuration.redirectUri === undefined
    ? { clientId, clientSecret }
    : {
        clientId,
        clientSecret,
        redirectUri: validateRedirectUri(
          configuration.redirectUri,
          AUTH_GOOGLE_CALLBACK_PATH,
          "GOOGLE_REDIRECT_URI",
        ),
      };
}

function createUnavailableResponse(cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  appendCookies(headers, cookies);

  return new Response("Google login is not configured", {
    headers,
    status: 503,
  });
}

function readGoogleUser(value: unknown): GoogleUserProfile {
  if (!isRecord(value)) {
    throw new Error("Google returned an invalid user profile");
  }

  const email = readProviderString(value, "email", "Google");
  const googleSubject = readProviderString(value, "sub", "Google");

  if (value["email_verified"] !== true) {
    throw new Error("Google did not verify the account email address");
  }

  const providedName = value["name"];
  const name =
    typeof providedName === "string" && providedName.length > 0
      ? providedName
      : email;
  const providedPicture = value["picture"];

  if (typeof providedPicture === "string" && providedPicture.length > 0) {
    return { email, googleSubject, name, picture: providedPicture };
  }

  return { email, googleSubject, name };
}

function createGoogleAuthentication(
  configuration: GoogleAuthConfiguration | undefined,
  dependencies: OAuthDependencies,
): GoogleAuth {
  const normalizedConfiguration =
    configuration === undefined
      ? undefined
      : normalizeConfiguration(configuration);
  const runtime = createOAuthRuntime(dependencies);
  const store = createDrizzleAuthStore(runtime.database, runtime.generateId);

  const authenticatedUser = (request: Request): AuthenticatedUser | null => {
    const now = expireSessions();
    const sessionToken = readCookie(request, SESSION_COOKIE);

    if (sessionToken === undefined) {
      return null;
    }

    return store.readSessionUser(sessionToken, now);
  };

  const revalidateUser = (
    request: Request,
    expectedUserId: string,
  ): AuthenticatedUser | null => {
    const user = authenticatedUser(request);
    return user?.id === expectedUserId ? user : null;
  };

  const begin = (request: Request): Response => {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    if (normalizedConfiguration === undefined) {
      return createUnavailableResponse();
    }

    const callbackRedirectUri = redirectUri(request);
    const flow = startPkceFlowForRedirect(
      runtime,
      GOOGLE_FLOW_COOKIES,
      callbackRedirectUri,
    );
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: normalizedConfiguration.clientId,
      code_challenge: flow.challenge,
      code_challenge_method: "S256",
      redirect_uri: callbackRedirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: flow.state,
    }).toString();

    const flowCookies = flow.cookies;
    return createRedirect(authorizationUrl, flowCookies);
  };

  const complete = async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    const secure = usesSecureCookiesForRequest(request);
    const clearedFlowCookies = clearPkceCookies(GOOGLE_FLOW_COOKIES, secure);

    if (normalizedConfiguration === undefined) {
      return createUnavailableResponse(clearedFlowCookies);
    }

    const callback = readOAuthCallback(request, GOOGLE_FLOW_COOKIES);
    if (callback.status !== "ready") {
      return appRedirect(request, callback.status, clearedFlowCookies);
    }

    try {
      const user = await authenticateWithGoogle(
        callback.code,
        callback.verifier,
        redirectUri(request),
        normalizedConfiguration,
      );
      const sessionToken = generateOAuthToken(runtime.randomToken);
      const now = expireSessions();
      store.createSession(
        sessionToken,
        user,
        now + SESSION_LIFETIME_SECONDS * 1000,
        now,
      );

      return appRedirect(request, undefined, [
        ...clearedFlowCookies,
        createCookie(
          SESSION_COOKIE,
          sessionToken,
          SESSION_LIFETIME_SECONDS,
          "/",
          secure,
        ),
      ]);
    } catch {
      return appRedirect(request, "failed", clearedFlowCookies);
    }
  };

  const logout = (request: Request): Response => {
    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("POST");
    }

    const sessionToken = readCookie(request, SESSION_COOKIE);

    if (sessionToken !== undefined) {
      store.revokeSession(sessionToken, runtime.now());
    }

    const headers = new Headers({ "cache-control": "no-store" });
    headers.append(
      "set-cookie",
      createCookie(
        SESSION_COOKIE,
        "",
        0,
        "/",
        usesSecureCookiesForRequest(request),
      ),
    );

    return new Response(null, { headers, status: 204 });
  };

  const session = (request: Request): Response => {
    if (request.method === "GET") {
      return createJsonResponse({
        googleLoginAvailable: normalizedConfiguration !== undefined,
        user: authenticatedUser(request),
      });
    }

    return createMethodNotAllowedResponse("GET");
  };

  const appRedirect = (
    request: Request,
    result: "denied" | "failed" | "invalid_state" | undefined,
    cookies: readonly string[],
  ): Response => {
    const callbackRedirectUri = redirectUri(request);
    return redirectToApp(
      APP_PATH,
      callbackRedirectUri,
      "auth",
      result,
      cookies,
    );
  };

  const authenticateWithGoogle = async (
    code: string,
    verifier: string,
    redirectUri: string,
    configuration: GoogleAuthConfiguration,
  ): Promise<GoogleUserProfile> => {
    const tokenValue = await postFormJson(
      runtime,
      GOOGLE_TOKEN_URL,
      {
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
      "Google rejected the authorization code",
    );
    const accessToken = readProviderString(
      tokenValue,
      "access_token",
      "Google",
    );
    const userInfoResponse = await runtime.fetch(GOOGLE_USERINFO_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    return readGoogleUser(
      await readJsonRecord(
        userInfoResponse,
        "Google rejected the user info request",
      ),
    );
  };

  const expireSessions = (): number => {
    const now = runtime.now();
    store.expireSessions(now);
    return now;
  };

  const redirectUri = (request: Request): string => {
    return resolveRedirectUri(
      normalizedConfiguration?.redirectUri,
      AUTH_GOOGLE_CALLBACK_PATH,
      request,
    );
  };

  const usesSecureCookiesForRequest = (request: Request): boolean => {
    return usesSecureCookies(redirectUri(request));
  };

  return {
    authenticatedUser,
    begin,
    complete,
    logout,
    revalidateUser,
    session,
  };
}

export function createGoogleAuthFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: OAuthDependencies = {},
): GoogleAuth {
  const clientId = normalizeOptionalValue(environment["GOOGLE_CLIENT_ID"]);
  const clientSecret = normalizeOptionalValue(
    environment["GOOGLE_CLIENT_SECRET"],
  );
  const redirectUri = normalizeOptionalValue(
    environment["GOOGLE_REDIRECT_URI"],
  );

  if (
    clientId === undefined &&
    clientSecret === undefined &&
    redirectUri === undefined
  ) {
    return createGoogleAuthentication(undefined, dependencies);
  }

  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set",
    );
  }

  const configuration: GoogleAuthConfiguration =
    redirectUri === undefined
      ? { clientId, clientSecret }
      : { clientId, clientSecret, redirectUri };
  return createGoogleAuthentication(configuration, dependencies);
}
