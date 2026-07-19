import { describe, expect, test } from "bun:test";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import { createOpenAiIntegrationFromEnvironment } from "../openai.ts";
import { createOpenRouterIntegrationFromEnvironment } from "../openrouter.ts";
import {
  API_BASE_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_HEARTBEAT_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNER_REGISTER_PATH,
  RUNNERS_PATH,
} from "../routes.ts";
import type { RunnerExecutableProvider } from "../runner-executable.ts";
import { createRunnerIntegration } from "../runners.ts";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  createRequestHandler,
} from "../server.ts";

interface CompressionCase {
  readonly decompress: (body: Uint8Array) => Uint8Array;
  readonly encoding: string;
}

const compressionCases: readonly CompressionCase[] = [
  { decompress: (body) => gunzipSync(body), encoding: "gzip" },
  { decompress: (body) => inflateSync(body), encoding: "deflate" },
  { decompress: (body) => brotliDecompressSync(body), encoding: "br" },
  { decompress: (body) => zstdDecompressSync(body), encoding: "zstd" },
];
const clientJavaScript = 'document.querySelector("#app")?.replaceChildren();';
const runnerExecutable = "standalone runner executable";
const runnerExecutables: RunnerExecutableProvider = {
  version: "a".repeat(64),
  serve: () =>
    Promise.resolve(
      new Response(runnerExecutable, {
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
};
const stylesheet = ".min-h-screen{min-height:100vh}";
const googleAuth = createGoogleAuthFromEnvironment({});
const handleRequest = createRequestHandler(
  clientJavaScript,
  stylesheet,
  googleAuth,
  createOpenAiIntegrationFromEnvironment({}, googleAuth),
  createOpenRouterIntegrationFromEnvironment({}, googleAuth),
  createRunnerIntegration(googleAuth),
  runnerExecutables,
);

function expectCompressionHeaders(
  response: Response,
  encoding: string | null,
): void {
  expect(response.headers.get("content-encoding")).toBe(encoding);
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
}

function expectStylesheetLink(body: string): void {
  expect(body).toContain('href="/styles.css" rel="stylesheet"');
}

async function expectUnencodedResponse(
  response: Response,
  status: number,
  body: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expectCompressionHeaders(response, null);
  expect(await response.text()).toBe(body);
}

async function sendRequest(
  path: string,
  acceptEncoding?: string,
  method = "GET",
): Promise<Response> {
  const headers = new Headers();

  if (acceptEncoding !== undefined) {
    headers.set("accept-encoding", acceptEncoding);
  }

  return await handleRequest(
    new Request(`http://localhost${path}`, {
      headers,
      method,
    }),
  );
}

async function request(path: string): Promise<{
  readonly body: string;
  readonly response: Response;
}> {
  const response = await sendRequest(path);

  return { body: await response.text(), response };
}

async function expectAsset(
  path: string,
  contentType: string,
  expectedBody: string,
): Promise<Response> {
  const { body, response } = await request(path);
  expect(response.headers.get("content-type")).toBe(contentType);
  expect(body).toBe(expectedBody);
  return response;
}

describe("routes", () => {
  test("places every authentication endpoint beneath the API base path", () => {
    expect(API_BASE_PATH).toBe("/api");
    expect(AUTH_GOOGLE_PATH).toBe("/api/auth/google");
    expect(AUTH_GOOGLE_CALLBACK_PATH).toBe("/api/auth/google/callback");
    expect(AUTH_LOGOUT_PATH).toBe("/api/auth/logout");
    expect(AUTH_SESSION_PATH).toBe("/api/auth/session");
    expect(OPENAI_CREDENTIALS_PATH).toBe("/api/openai/credentials");
    expect(OPENAI_OAUTH_PATH).toBe("/api/openai/oauth");
    expect(OPENAI_OAUTH_CALLBACK_PATH).toBe("/api/openai/oauth/callback");
    expect(OPENROUTER_CREDENTIALS_PATH).toBe("/api/openrouter/credentials");
    expect(OPENROUTER_OAUTH_PATH).toBe("/api/openrouter/oauth");
    expect(OPENROUTER_OAUTH_CALLBACK_PATH).toBe(
      "/api/openrouter/oauth/callback",
    );
    expect(RUNNERS_PATH).toBe("/api/runners");
    expect(RUNNER_REGISTER_PATH).toBe("/api/runner/register");
    expect(RUNNER_HEARTBEAT_PATH).toBe("/api/runner/heartbeat");
    expect(RUNNER_INSTALLER_PATH).toBe("/runner/install.sh");
    expect(RUNNER_EXECUTABLE_PATH).toBe("/runner/executable");
  });
});

describe("page server", () => {
  test("server renders the home page", async () => {
    const { body, response } = await request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(body).toStartWith("<!doctype html>");
    expect(body).toContain("<h1");
    expect(body).toContain(">Q Mush</h1>");
    expect(body).toContain('href="/app"');
    expectStylesheetLink(body);
    expect(body).not.toContain('src="/app.js"');
  });

  test("serves an empty app root for the client to render", async () => {
    const { body, response } = await request("/app?source=test");

    expect(response.status).toBe(200);
    expect(body).toContain('<main id="app"');
    expect(body).toContain('<script src="/app.js" type="module"></script>');
    expectStylesheetLink(body);
    expect(body).not.toContain("<h1>Q Mush App</h1>");
  });

  test("serves the browser bundle", async () => {
    await expectAsset(
      "/app.js",
      "text/javascript; charset=utf-8",
      clientJavaScript,
    );
  });

  test("serves the stylesheet", async () => {
    const response = await expectAsset(
      "/styles.css",
      "text/css; charset=utf-8",
      stylesheet,
    );
    expectCompressionHeaders(response, null);
  });

  test("serves the standalone runner executable", async () => {
    await expectAsset(
      `${RUNNER_EXECUTABLE_PATH}?target=bun-linux-x64-baseline`,
      "application/octet-stream",
      runnerExecutable,
    );
  });

  test("protects user runner routes and exposes runner callbacks", async () => {
    const collectionResponse = await sendRequest(RUNNERS_PATH);
    const setupResponse = await sendRequest(RUNNERS_PATH, undefined, "POST");
    const registrationResponse = await sendRequest(
      RUNNER_REGISTER_PATH,
      undefined,
      "POST",
    );
    const heartbeatResponse = await sendRequest(
      RUNNER_HEARTBEAT_PATH,
      undefined,
      "POST",
    );
    const installerResponse = await sendRequest(
      `${RUNNER_INSTALLER_PATH}?token=qmr_unknown-token`,
    );

    expect(collectionResponse.status).toBe(401);
    expect(setupResponse.status).toBe(401);
    expect(registrationResponse.status).toBe(401);
    expect(heartbeatResponse.status).toBe(401);
    expect(installerResponse.status).toBe(404);
  });

  test("serves the authentication session endpoint", async () => {
    const response = await sendRequest("/api/auth/session");

    expect(response.ok).toBeTrue();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      '{"googleLoginAvailable":false,"user":null}',
    );
  });

  test("routes authentication requests beneath the API base path", async () => {
    const loginResponse = await sendRequest("/api/auth/google");
    const invalidLogoutResponse = await sendRequest("/api/auth/logout");
    const logoutResponse = await sendRequest(
      "/api/auth/logout",
      undefined,
      "POST",
    );
    const outsideApiResponse = await sendRequest("/auth/google");

    expect(loginResponse.status).toBe(503);
    expect(invalidLogoutResponse.status).toBe(405);
    expect(invalidLogoutResponse.headers.get("allow")).toBe("POST");
    expect(logoutResponse.status).toBe(204);
    expect(outsideApiResponse.status).toBe(404);
  });

  for (const provider of [
    {
      callbackPath: OPENAI_OAUTH_CALLBACK_PATH,
      credentialsPath: OPENAI_CREDENTIALS_PATH,
      name: "OpenAI",
      oauthPath: OPENAI_OAUTH_PATH,
      outsidePath: "/openai/oauth",
    },
    {
      callbackPath: OPENROUTER_OAUTH_CALLBACK_PATH,
      credentialsPath: OPENROUTER_CREDENTIALS_PATH,
      name: "OpenRouter",
      oauthPath: OPENROUTER_OAUTH_PATH,
      outsidePath: "/openrouter/oauth",
    },
  ]) {
    test(`routes protected ${provider.name} requests`, async () => {
      const responses = await Promise.all([
        sendRequest(provider.oauthPath),
        sendRequest(provider.callbackPath),
        sendRequest(provider.credentialsPath),
        sendRequest(
          `${provider.credentialsPath}/credential-id`,
          undefined,
          "DELETE",
        ),
      ]);
      const outsideApiResponse = await sendRequest(provider.outsidePath);

      expect(responses.every(({ status }) => status === 401)).toBeTrue();
      expect(outsideApiResponse.status).toBe(404);
    });
  }

  test("returns not found for unknown paths", async () => {
    const { body, response } = await request("/missing");

    expect(response.status).toBe(404);
    expect(body).toBe("Not found");
  });
});

describe("response compression", () => {
  for (const { decompress, encoding } of compressionCases) {
    test(`serves ${encoding}-compressed responses`, async () => {
      const response = await sendRequest("/styles.css", encoding);
      const compressedBody = new Uint8Array(await response.arrayBuffer());

      expectCompressionHeaders(response, encoding);
      expect(new TextDecoder().decode(decompress(compressedBody))).toBe(
        stylesheet,
      );
    });
  }

  test("prefers zstd when the client accepts every supported encoding", async () => {
    const response = await sendRequest(
      "/styles.css",
      "gzip, deflate, br, zstd",
    );

    expectCompressionHeaders(response, "zstd");
  });

  test("honors client encoding quality preferences", async () => {
    const response = await sendRequest(
      "/styles.css",
      "gzip;q=1, deflate;q=0.8, br;q=0.5, zstd;q=0.2",
    );

    expectCompressionHeaders(response, "gzip");
  });

  test("uses identity when the client prefers it", async () => {
    const response = await sendRequest(
      "/styles.css",
      "gzip;q=0.5, identity;q=1",
    );

    await expectUnencodedResponse(response, 200, stylesheet);
  });

  test("returns not acceptable when the client rejects every representation", async () => {
    const response = await sendRequest("/styles.css", "identity;q=0, *;q=0");

    await expectUnencodedResponse(response, 406, "");
  });
});

describe("browser build", () => {
  test("builds the login, session, and provider credential controls", async () => {
    const javaScript = await buildClientJavaScript();

    expect(javaScript).toContain("Continue with Google");
    expect(javaScript).toContain("Connect OpenAI account");
    expect(javaScript).toContain("Connect OpenRouter account");
    expect(javaScript).toContain("Add API key");
    expect(javaScript).toContain("Set up a runner");
    expect(javaScript).toContain("Download installer");
    expect(javaScript).toContain("AUTH_GOOGLE_PATH");
    expect(javaScript).toContain("AUTH_LOGOUT_PATH");
    expect(javaScript).toContain("OPENAI_CREDENTIALS_PATH");
    expect(javaScript).toContain("OPENROUTER_CREDENTIALS_PATH");
    expect(javaScript).toContain("RUNNERS_PATH");
  });
});

describe("stylesheet build", () => {
  test("builds the Tailwind stylesheet in memory", async () => {
    const css = await buildClientStylesheet();

    expect(css).toContain("tailwindcss");
    expect(css).toContain(".min-h-screen");
    expect(css).toContain(".bg-slate-950");
  });
});
