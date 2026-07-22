import { isRecord, type AuthenticatedUser } from "../shared/auth-model.ts";
import {
  APP_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
} from "../shared/routes.ts";
import { DrizzleAuthStore, type GoogleUserProfile } from "./auth-store.ts";
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
  type OAuthRuntime,
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

class GoogleAuthentication implements GoogleAuth {
  readonly #configuration: GoogleAuthConfiguration | undefined;
  readonly #runtime: OAuthRuntime;
  readonly #store: DrizzleAuthStore;

  constructor(
    configuration: GoogleAuthConfiguration | undefined,
    dependencies: OAuthDependencies,
  ) {
    this.#configuration =
      configuration === undefined
        ? undefined
        : normalizeConfiguration(configuration);
    this.#runtime = createOAuthRuntime(dependencies);
    this.#store = new DrizzleAuthStore(
      this.#runtime.database,
      this.#runtime.generateId,
    );
  }

  authenticatedUser(request: Request): AuthenticatedUser | null {
    const now = this.#expireSessions();
    const sessionToken = readCookie(request, SESSION_COOKIE);

    if (sessionToken === undefined) {
      return null;
    }

    return this.#store.readSessionUser(sessionToken, now);
  }

  begin(request: Request): Response {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    if (this.#configuration === undefined) {
      return createUnavailableResponse();
    }

    const redirectUri = this.#redirectUri(request);
    const flow = startPkceFlowForRedirect(
      this.#runtime,
      GOOGLE_FLOW_COOKIES,
      redirectUri,
    );
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: this.#configuration.clientId,
      code_challenge: flow.challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: flow.state,
    }).toString();

    const flowCookies = flow.cookies;
    return createRedirect(authorizationUrl, flowCookies);
  }

  async complete(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    const secure = this.#usesSecureCookies(request);
    const clearedFlowCookies = clearPkceCookies(GOOGLE_FLOW_COOKIES, secure);

    if (this.#configuration === undefined) {
      return createUnavailableResponse(clearedFlowCookies);
    }

    const callback = readOAuthCallback(request, GOOGLE_FLOW_COOKIES);

    if (callback.status !== "ready") {
      return this.#appRedirect(request, callback.status, clearedFlowCookies);
    }

    try {
      const user = await this.#authenticateWithGoogle(
        callback.code,
        callback.verifier,
        this.#redirectUri(request),
        this.#configuration,
      );
      const sessionToken = generateOAuthToken(this.#runtime.randomToken);
      const now = this.#expireSessions();
      this.#store.createSession(
        sessionToken,
        user,
        now + SESSION_LIFETIME_SECONDS * 1000,
        now,
      );

      return this.#appRedirect(request, undefined, [
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
      return this.#appRedirect(request, "failed", clearedFlowCookies);
    }
  }

  logout(request: Request): Response {
    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("POST");
    }

    const sessionToken = readCookie(request, SESSION_COOKIE);

    if (sessionToken !== undefined) {
      this.#store.revokeSession(sessionToken, this.#runtime.now());
    }

    const headers = new Headers({ "cache-control": "no-store" });
    headers.append(
      "set-cookie",
      createCookie(
        SESSION_COOKIE,
        "",
        0,
        "/",
        this.#usesSecureCookies(request),
      ),
    );

    return new Response(null, { headers, status: 204 });
  }

  session(request: Request): Response {
    if (request.method === "GET") {
      return createJsonResponse({
        googleLoginAvailable: this.#configuration !== undefined,
        user: this.authenticatedUser(request),
      });
    }

    return createMethodNotAllowedResponse("GET");
  }

  #appRedirect(
    request: Request,
    result: "denied" | "failed" | "invalid_state" | undefined,
    cookies: readonly string[],
  ): Response {
    const redirectUri = this.#redirectUri(request);
    return redirectToApp(APP_PATH, redirectUri, "auth", result, cookies);
  }

  async #authenticateWithGoogle(
    code: string,
    verifier: string,
    redirectUri: string,
    configuration: GoogleAuthConfiguration,
  ): Promise<GoogleUserProfile> {
    const tokenValue = await postFormJson(
      this.#runtime,
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
    const userInfoResponse = await this.#runtime.fetch(GOOGLE_USERINFO_URL, {
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
  }

  #expireSessions(): number {
    const now = this.#runtime.now();
    this.#store.expireSessions(now);
    return now;
  }

  #redirectUri(request: Request): string {
    return resolveRedirectUri(
      this.#configuration?.redirectUri,
      AUTH_GOOGLE_CALLBACK_PATH,
      request,
    );
  }

  #usesSecureCookies(request: Request): boolean {
    return usesSecureCookies(this.#redirectUri(request));
  }
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
    return new GoogleAuthentication(undefined, dependencies);
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
  return new GoogleAuthentication(configuration, dependencies);
}
