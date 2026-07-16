import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isRecord, type AuthenticatedUser } from "./auth-model.ts";
import {
  APP_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
} from "./routes.ts";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_STATE_COOKIE = "q_mush_oauth_state";
const OAUTH_VERIFIER_COOKIE = "q_mush_oauth_verifier";
const SESSION_COOKIE = "q_mush_session";
const FLOW_COOKIE_PATH = AUTH_GOOGLE_PATH;
const FLOW_LIFETIME_SECONDS = 10 * 60;
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z\d_-]+$/u;

interface StoredSession {
  readonly expiresAt: number;
  readonly user: AuthenticatedUser;
}

interface GoogleAuthConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri?: string;
}

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface GoogleAuthDependencies {
  readonly fetch?: ProviderFetch;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

export interface GoogleAuth {
  begin(request: Request): Response;
  complete(request: Request): Promise<Response>;
  logout(request: Request): Response;
  session(request: Request): Response;
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function normalizeConfiguration(
  configuration: GoogleAuthConfiguration,
): GoogleAuthConfiguration {
  const clientId = configuration.clientId.trim();
  const clientSecret = configuration.clientSecret.trim();

  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new Error("Google OAuth credentials cannot be empty");
  }

  if (configuration.redirectUri === undefined) {
    return { clientId, clientSecret };
  }

  const redirectUrl = new URL(configuration.redirectUri);

  if (
    (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") ||
    redirectUrl.pathname !== AUTH_GOOGLE_CALLBACK_PATH ||
    redirectUrl.search.length > 0 ||
    redirectUrl.hash.length > 0
  ) {
    throw new Error(
      `GOOGLE_REDIRECT_URI must be an HTTP(S) URL ending in ${AUTH_GOOGLE_CALLBACK_PATH}`,
    );
  }

  return { clientId, clientSecret, redirectUri: redirectUrl.toString() };
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");

  if (cookieHeader === null) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const cookieName = part.slice(0, separatorIndex).trim();

    if (cookieName === name) {
      return part.slice(separatorIndex + 1).trim();
    }
  }

  return undefined;
}

function createCookie(
  name: string,
  value: string,
  maxAge: number,
  path: string,
  secure: boolean,
): string {
  const secureAttribute = secure ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; Max-Age=${String(maxAge)}; Path=${path}; SameSite=Lax${secureAttribute}`;
}

function appendCookies(headers: Headers, cookies: readonly string[]): void {
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
}

function createRedirect(location: URL, cookies: readonly string[]): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location: location.toString(),
    "referrer-policy": "no-referrer",
  });
  appendCookies(headers, cookies);

  return new Response(null, { headers, status: 302 });
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

function createMethodNotAllowedResponse(
  allowedMethod: "GET" | "POST",
): Response {
  return new Response("Method not allowed", {
    headers: {
      allow: allowedMethod,
      "content-type": "text/plain; charset=utf-8",
    },
    status: 405,
  });
}

function createSessionResponse(
  googleLoginAvailable: boolean,
  user: AuthenticatedUser | null,
): Response {
  return new Response(JSON.stringify({ googleLoginAvailable, user }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function valuesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function readRequiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Google returned an invalid ${key}`);
  }

  return value;
}

function readGoogleUser(value: unknown): AuthenticatedUser {
  if (!isRecord(value)) {
    throw new Error("Google returned an invalid user profile");
  }

  const email = readRequiredString(value, "email");
  const id = readRequiredString(value, "sub");

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
    return { email, id, name, picture: providedPicture };
  }

  return { email, id, name };
}

class GoogleAuthentication implements GoogleAuth {
  readonly #configuration: GoogleAuthConfiguration | undefined;
  readonly #now: () => number;
  readonly #providerFetch: ProviderFetch;
  readonly #randomToken: () => string;
  readonly #sessions = new Map<string, StoredSession>();

  constructor(
    configuration: GoogleAuthConfiguration | undefined,
    dependencies: GoogleAuthDependencies,
  ) {
    this.#configuration =
      configuration === undefined
        ? undefined
        : normalizeConfiguration(configuration);
    this.#now = dependencies.now ?? Date.now;
    this.#providerFetch = dependencies.fetch ?? globalThis.fetch;
    this.#randomToken = dependencies.randomToken ?? defaultRandomToken;
  }

  begin(request: Request): Response {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    if (this.#configuration === undefined) {
      return createUnavailableResponse();
    }

    const redirectUri = this.#redirectUri(request);
    const secure = new URL(redirectUri).protocol === "https:";
    const state = this.#generateToken();
    const verifier = this.#generateToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);

    authorizationUrl.search = new URLSearchParams({
      client_id: this.#configuration.clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    }).toString();

    return createRedirect(authorizationUrl, [
      createCookie(
        OAUTH_STATE_COOKIE,
        state,
        FLOW_LIFETIME_SECONDS,
        FLOW_COOKIE_PATH,
        secure,
      ),
      createCookie(
        OAUTH_VERIFIER_COOKIE,
        verifier,
        FLOW_LIFETIME_SECONDS,
        FLOW_COOKIE_PATH,
        secure,
      ),
    ]);
  }

  async complete(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return createMethodNotAllowedResponse("GET");
    }

    const secure = this.#usesSecureCookies(request);
    const clearedFlowCookies = this.#clearedFlowCookies(secure);

    if (this.#configuration === undefined) {
      return createUnavailableResponse(clearedFlowCookies);
    }

    const callbackUrl = new URL(request.url);
    const expectedState = readCookie(request, OAUTH_STATE_COOKIE);
    const returnedState = callbackUrl.searchParams.get("state");
    const verifier = readCookie(request, OAUTH_VERIFIER_COOKIE);

    if (
      expectedState === undefined ||
      returnedState === null ||
      verifier === undefined ||
      !valuesMatch(expectedState, returnedState)
    ) {
      return this.#appRedirect(request, "invalid_state", clearedFlowCookies);
    }

    const providerError = callbackUrl.searchParams.get("error");

    if (providerError !== null) {
      return this.#appRedirect(
        request,
        providerError === "access_denied" ? "denied" : "failed",
        clearedFlowCookies,
      );
    }

    const code = callbackUrl.searchParams.get("code");

    if (code === null || code.length === 0) {
      return this.#appRedirect(request, "failed", clearedFlowCookies);
    }

    try {
      const user = await this.#authenticateWithGoogle(
        code,
        verifier,
        this.#redirectUri(request),
        this.#configuration,
      );
      const sessionId = this.#generateToken();

      this.#removeExpiredSessions();
      this.#sessions.set(sessionId, {
        expiresAt: this.#now() + SESSION_LIFETIME_SECONDS * 1000,
        user,
      });

      return this.#appRedirect(request, undefined, [
        ...clearedFlowCookies,
        createCookie(
          SESSION_COOKIE,
          sessionId,
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

    const sessionId = readCookie(request, SESSION_COOKIE);

    if (sessionId !== undefined) {
      this.#sessions.delete(sessionId);
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
      this.#removeExpiredSessions();

      const sessionId = readCookie(request, SESSION_COOKIE);
      const storedSession =
        sessionId === undefined ? undefined : this.#sessions.get(sessionId);

      return createSessionResponse(
        this.#configuration !== undefined,
        storedSession?.user ?? null,
      );
    }

    return createMethodNotAllowedResponse("GET");
  }

  #appRedirect(
    request: Request,
    result: "denied" | "failed" | "invalid_state" | undefined,
    cookies: readonly string[],
  ): Response {
    const appUrl = new URL(APP_PATH, this.#redirectUri(request));

    if (result !== undefined) {
      appUrl.searchParams.set("auth", result);
    }

    return createRedirect(appUrl, cookies);
  }

  async #authenticateWithGoogle(
    code: string,
    verifier: string,
    redirectUri: string,
    configuration: GoogleAuthConfiguration,
  ): Promise<AuthenticatedUser> {
    const tokenResponse = await this.#providerFetch(GOOGLE_TOKEN_URL, {
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    if (!tokenResponse.ok) {
      throw new Error("Google rejected the authorization code");
    }

    const tokenValue: unknown = await tokenResponse.json();

    if (!isRecord(tokenValue)) {
      throw new Error("Google returned an invalid token response");
    }

    const accessToken = readRequiredString(tokenValue, "access_token");
    const userInfoResponse = await this.#providerFetch(GOOGLE_USERINFO_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userInfoResponse.ok) {
      throw new Error("Google rejected the user info request");
    }

    const userValue: unknown = await userInfoResponse.json();
    return readGoogleUser(userValue);
  }

  #clearedFlowCookies(secure: boolean): readonly string[] {
    return [
      createCookie(OAUTH_STATE_COOKIE, "", 0, FLOW_COOKIE_PATH, secure),
      createCookie(OAUTH_VERIFIER_COOKIE, "", 0, FLOW_COOKIE_PATH, secure),
    ];
  }

  #generateToken(): string {
    const token = this.#randomToken();

    if (!TOKEN_PATTERN.test(token)) {
      throw new Error("The random token generator returned an invalid token");
    }

    return token;
  }

  #redirectUri(request: Request): string {
    return (
      this.#configuration?.redirectUri ??
      new URL(AUTH_GOOGLE_CALLBACK_PATH, request.url).toString()
    );
  }

  #removeExpiredSessions(): void {
    const now = this.#now();

    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  #usesSecureCookies(request: Request): boolean {
    return new URL(this.#redirectUri(request)).protocol === "https:";
  }
}

function createGoogleAuth(
  configuration?: GoogleAuthConfiguration,
  dependencies: GoogleAuthDependencies = {},
): GoogleAuth {
  return new GoogleAuthentication(configuration, dependencies);
}

export function createGoogleAuthFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: GoogleAuthDependencies = {},
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
    return createGoogleAuth(undefined, dependencies);
  }

  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set",
    );
  }

  return redirectUri === undefined
    ? createGoogleAuth({ clientId, clientSecret }, dependencies)
    : createGoogleAuth({ clientId, clientSecret, redirectUri }, dependencies);
}
