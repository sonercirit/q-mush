import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createGoogleAuthFromEnvironment, type GoogleAuth } from "../auth.ts";

const CALLBACK_URL = "http://localhost:3000/api/auth/google/callback";
const TEST_ENVIRONMENT = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: CALLBACK_URL,
};
const STATE = "test-state-token";
const VERIFIER = "test-pkce-code-verifier";
const SESSION_ID = "test-session-id";

function readSetCookie(response: Response, name: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));

  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`);
  }

  return cookie;
}

function readCookiePair(response: Response, name: string): string {
  const pair = readSetCookie(response, name).split(";", 1)[0];

  if (pair === undefined) {
    throw new Error(`Invalid ${name} cookie`);
  }

  return pair;
}

function createTokenGenerator(): () => string {
  const tokens = [STATE, VERIFIER, SESSION_ID];

  return () => {
    const token = tokens.shift();

    if (token === undefined) {
      throw new Error("The test ran out of deterministic tokens");
    }

    return token;
  };
}

type AuthDependencies = NonNullable<
  Parameters<typeof createGoogleAuthFromEnvironment>[1]
>;
type ProviderFetch = NonNullable<AuthDependencies["fetch"]>;

interface StartedFlow {
  readonly cookies: string;
  readonly response: Response;
}

function createTestAuth(providerFetch?: ProviderFetch): GoogleAuth {
  const randomToken = createTokenGenerator();
  const dependencies =
    providerFetch === undefined
      ? { randomToken }
      : { fetch: providerFetch, randomToken };

  return createGoogleAuthFromEnvironment(TEST_ENVIRONMENT, dependencies);
}

function startFlow(auth: GoogleAuth): StartedFlow {
  const response = auth.begin(
    new Request("http://localhost:3000/api/auth/google"),
  );
  const cookies = [
    readCookiePair(response, "q_mush_oauth_state"),
    readCookiePair(response, "q_mush_oauth_verifier"),
  ].join("; ");

  return { cookies, response };
}

function completeFlow(auth: GoogleAuth, query: string): Promise<Response> {
  const { cookies } = startFlow(auth);
  return auth.complete(createCallbackRequest(query, cookies));
}

function createCallbackRequest(query: string, cookie: string): Request {
  return new Request(`${CALLBACK_URL}?${query}`, {
    headers: { cookie },
  });
}

function createAuthenticatedRequest(
  path: string,
  cookie: string,
  method = "GET",
): Request {
  return new Request(`http://localhost:3000${path}`, {
    headers: { cookie },
    method,
  });
}

describe("Google authentication", () => {
  test("starts an authorization-code flow with state and PKCE", () => {
    const auth = createTestAuth();
    const { response } = startFlow(auth);
    const location = response.headers.get("location");

    expect(response.status).toBe(302);
    expect(location).not.toBeNull();

    if (location === null) {
      throw new Error("Missing authorization redirect");
    }

    const authorizationUrl = new URL(location);
    const expectedChallenge = createHash("sha256")
      .update(VERIFIER)
      .digest("base64url");

    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      TEST_ENVIRONMENT.GOOGLE_CLIENT_ID,
    );
    expect(authorizationUrl.searchParams.get("client_secret")).toBeNull();
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      CALLBACK_URL,
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid email profile",
    );
    expect(authorizationUrl.searchParams.get("state")).toBe(STATE);
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
      expectedChallenge,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(readSetCookie(response, "q_mush_oauth_state")).toContain("HttpOnly");
    expect(readSetCookie(response, "q_mush_oauth_verifier")).toContain(
      "SameSite=Lax",
    );
  });

  test("exchanges the code and creates a local session", async () => {
    const providerRequests: Request[] = [];
    const providerFetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      providerRequests.push(request);

      if (request.url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(
          Response.json({ access_token: "google-access-token" }),
        );
      }

      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return Promise.resolve(
          Response.json({
            email: "mushroom@example.com",
            email_verified: true,
            name: "Mush Room",
            picture: "https://example.com/avatar.png",
            sub: "google-user-1",
          }),
        );
      }

      return Promise.resolve(
        new Response("Unexpected provider request", { status: 500 }),
      );
    };
    const auth = createTestAuth(providerFetch);
    const { cookies: flowCookies } = startFlow(auth);
    const callbackResponse = await auth.complete(
      createCallbackRequest(`code=google-code&state=${STATE}`, flowCookies),
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe(
      "http://localhost:3000/app",
    );
    expect(readSetCookie(callbackResponse, "q_mush_oauth_state")).toContain(
      "Max-Age=0",
    );
    expect(readSetCookie(callbackResponse, "q_mush_oauth_verifier")).toContain(
      "Max-Age=0",
    );

    const tokenRequest = providerRequests[0];
    const userInfoRequest = providerRequests[1];

    if (tokenRequest === undefined || userInfoRequest === undefined) {
      throw new Error("Google provider requests were not made");
    }

    const tokenParameters = new URLSearchParams(await tokenRequest.text());

    expect(tokenRequest.method).toBe("POST");
    expect(tokenParameters.get("client_id")).toBe(
      TEST_ENVIRONMENT.GOOGLE_CLIENT_ID,
    );
    expect(tokenParameters.get("client_secret")).toBe(
      TEST_ENVIRONMENT.GOOGLE_CLIENT_SECRET,
    );
    expect(tokenParameters.get("code")).toBe("google-code");
    expect(tokenParameters.get("code_verifier")).toBe(VERIFIER);
    expect(tokenParameters.get("grant_type")).toBe("authorization_code");
    expect(userInfoRequest.headers.get("authorization")).toBe(
      "Bearer google-access-token",
    );

    const sessionCookie = readCookiePair(callbackResponse, "q_mush_session");
    const sessionResponse = auth.session(
      createAuthenticatedRequest("/api/auth/session", sessionCookie),
    );

    expect(sessionResponse.headers.get("cache-control")).toBe("no-store");
    expect(await sessionResponse.json()).toEqual({
      googleLoginAvailable: true,
      user: {
        email: "mushroom@example.com",
        id: "google-user-1",
        name: "Mush Room",
        picture: "https://example.com/avatar.png",
      },
    });

    const logoutResponse = auth.logout(
      createAuthenticatedRequest("/api/auth/logout", sessionCookie, "POST"),
    );

    expect(logoutResponse.status).toBe(204);
    expect(readSetCookie(logoutResponse, "q_mush_session")).toContain(
      "Max-Age=0",
    );
    expect(
      await auth
        .session(createAuthenticatedRequest("/api/auth/session", sessionCookie))
        .json(),
    ).toEqual({ googleLoginAvailable: true, user: null });
  });

  test("rejects a callback whose state does not match", async () => {
    let providerWasCalled = false;
    const auth = createTestAuth(() => {
      providerWasCalled = true;
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    const response = await completeFlow(
      auth,
      "code=google-code&state=wrong-state",
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/app?auth=invalid_state",
    );
    expect(providerWasCalled).toBeFalse();
  });

  test("returns a safe result when the user denies access", async () => {
    const auth = createTestAuth();
    const response = await completeFlow(
      auth,
      `error=access_denied&state=${STATE}`,
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/app?auth=denied",
    );
  });

  test("reports when Google login is not configured", async () => {
    const auth = createGoogleAuthFromEnvironment({});
    const sessionResponse = auth.session(
      new Request("http://localhost:3000/api/auth/session"),
    );

    expect(await sessionResponse.json()).toEqual({
      googleLoginAvailable: false,
      user: null,
    });
    expect(
      auth.begin(new Request("http://localhost:3000/api/auth/google")).status,
    ).toBe(503);
  });

  test("rejects incomplete environment configuration", () => {
    expect(() =>
      createGoogleAuthFromEnvironment({ GOOGLE_CLIENT_ID: "client-only" }),
    ).toThrow("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set");
  });
});
