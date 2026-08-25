import { createHash } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  BRAVE_SEARCH_KEYS_PATH,
  FAVICON_PATH,
  GENERIC_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  promptPath,
  PROMPTS_PATH,
  providerCredentialDefaultPath,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNER_SUPERVISOR_PATH,
  runnerDefaultPath,
  runnerDirectoriesPath,
  RUNNERS_PATH,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
  TOOL_SETTINGS_PATH,
} from "../../shared/routes.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import type { BraveSearchSkill } from "../../sync-engine/brave-search.ts";
import { readFavicon } from "../../sync-engine/client-build.ts";
import { createGenericIntegrationFromEnvironment } from "../../sync-engine/generic-provider.ts";
import { createOpenAiIntegrationFromEnvironment } from "../../sync-engine/openai.ts";
import { createOpenRouterIntegrationFromEnvironment } from "../../sync-engine/openrouter.ts";
import { renderPages } from "../../sync-engine/pages.ts";
import { createDrizzlePromptIntegration } from "../../sync-engine/prompts.ts";
import type { RunnerExecutableProvider } from "../../sync-engine/runner-executable.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import { createRequestHandler } from "../../sync-engine/server.ts";
import { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { createToolSettingsIntegration } from "../../sync-engine/tool-settings.ts";
import { createWorkspaceStore } from "../../sync-engine/workspace-store.ts";
import { createWorkspaceIntegration } from "../../sync-engine/workspaces.ts";
import {
  createSchemaCompatibleTestDatabase,
  expectResponseStatuses,
} from "./authenticated-integration-test-helpers.ts";
import { unavailableProviderResponse } from "./provider-fetch-fixtures.ts";

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
  compile: () => Promise.resolve(new Blob()),
  version: "a".repeat(64),
  serve: () =>
    Promise.resolve(
      new Response(runnerExecutable, {
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
  serveSupervisor: () =>
    Promise.resolve(
      new Response("standalone runner supervisor", {
        headers: { "content-type": "application/octet-stream" },
      }),
    ),
};
const stylesheet = ".min-h-screen{min-height:100vh}";
function unavailableResponse(): Promise<Response> {
  return unavailableProviderResponse(401);
}

const braveSearch: BraveSearchSkill = {
  execute: () =>
    Promise.resolve("Error: no Brave Search API keys are available."),
  keys: unavailableResponse,
  remove: () => new Response(null, { status: 401 }),
  setScopes: unavailableResponse,
};
const pages = await renderPages();
function createTestRequestHandler(): (request: Request) => Promise<Response> {
  const database = createSchemaCompatibleTestDatabase();
  const integrationDependencies = { database };
  const googleAuth = createGoogleAuthFromEnvironment(
    {},
    integrationDependencies,
  );
  const generic = createGenericIntegrationFromEnvironment(
    {},
    googleAuth,
    integrationDependencies,
  );
  const openAi = createOpenAiIntegrationFromEnvironment(
    {},
    googleAuth,
    integrationDependencies,
  );
  const openRouter = createOpenRouterIntegrationFromEnvironment(
    {},
    googleAuth,
    integrationDependencies,
  );

  const runners = createRunnerIntegration(googleAuth, integrationDependencies);
  const workspaceStore = createWorkspaceStore(database);
  const workspaces = createWorkspaceIntegration({
    auth: googleAuth,
    store: workspaceStore,
  });
  const modelProviders = { generic, openai: openAi, openrouter: openRouter };
  const sessions = createSessionIntegration(
    googleAuth,
    runners,
    modelProviders,
    {
      braveSearch,
      database,
      liveness: { setInterval: () => undefined },
      workspaces,
    },
  );
  const integrations = {
    braveSearch,
    database,
    generic,
    googleAuth,
    openAi,
    openRouter,
    prompts: createDrizzlePromptIntegration(
      googleAuth,
      integrationDependencies,
    ),
    runnerExecutables,
    runners,
    sessions,
    toolSettings: createToolSettingsIntegration(
      googleAuth,
      integrationDependencies,
    ),
    workspaces,
  };
  return createRequestHandler(
    clientJavaScript,
    stylesheet,
    pages,
    integrations,
  );
}

const handleRequest = createTestRequestHandler();

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
  requestHeaders?: HeadersInit,
): Promise<Response> {
  const headers = new Headers(requestHeaders);

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

async function expectProtectedApiAndOutsidePath(
  requests: readonly Promise<Response>[],
  outsidePath: string,
): Promise<void> {
  const [responses, outside] = await Promise.all([
    Promise.all(requests),
    sendRequest(outsidePath),
  ]);
  expectResponseStatuses(responses, 401);
  expect(outside.status).toBe(404);
}

describe("page server", () => {
  test("server renders the home page", async () => {
    const { body, response } = await request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(body.startsWith("<!doctype html>")).toBe(true);
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

  test("serves the exact public favicon with safe response headers", async () => {
    const source = Bun.file(
      new URL("../../solid/favicon.svg", import.meta.url),
    );
    const expectedBody = new Uint8Array(await source.arrayBuffer());
    const response = await sendRequest(FAVICON_PATH);
    const body = new Uint8Array(await response.arrayBuffer());
    const expectedTag = `W/"${createHash("sha256").update(expectedBody).digest("hex")}"`;
    const contentType = response.headers.get("content-type");

    expect(response.status).toBe(200);
    expect(contentType).toMatch(/^image\/svg\+xml(?:;|$)/u);
    expect(contentType).not.toMatch(/^text\/html(?:;|$)/u);
    expect(body).toEqual(expectedBody);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=86400, must-revalidate",
    );
    expect(response.headers.get("etag")).toBe(expectedTag);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expectCompressionHeaders(response, null);
  });

  test("supports compressed, conditional, and HEAD favicon requests", async () => {
    const source = readFavicon();
    const compressed = await sendRequest(FAVICON_PATH, "br");
    const compressedBody = new Uint8Array(await compressed.arrayBuffer());
    const tag = compressed.headers.get("etag");
    const head = await sendRequest(FAVICON_PATH, "br", "HEAD");
    const notModified = await sendRequest(
      FAVICON_PATH,
      "br",
      "GET",
      tag === null
        ? undefined
        : { "if-none-match": `"other", ${tag.replace(/^W\//u, "")}` },
    );

    expect(compressed.status).toBe(200);
    expectCompressionHeaders(compressed, "br");
    expect(new TextDecoder().decode(brotliDecompressSync(compressedBody))).toBe(
      source,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8",
    );
    expect(head.headers.get("content-encoding")).toBe("br");
    expect(head.headers.get("content-length")).toBe(
      String(compressedBody.byteLength),
    );
    expect(head.headers.get("etag")).toBe(tag);
    expectCompressionHeaders(head, "br");
    expect(await head.text()).toBe("");
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("cache-control")).toBe(
      "public, max-age=86400, must-revalidate",
    );
    expect(notModified.headers.get("etag")).toBe(tag);
    expect(notModified.headers.get("content-encoding")).toBeNull();
    expect(notModified.headers.get("vary")).toBe("Accept-Encoding");
    expect(await notModified.text()).toBe("");
  });

  test("rejects unsupported favicon methods and keeps the legacy URL absent", async () => {
    const methodResponse = await sendRequest(FAVICON_PATH, undefined, "POST");
    const legacyResponse = await sendRequest("/favicon.ico");
    const legacyHeadResponse = await sendRequest(
      "/favicon.ico",
      undefined,
      "HEAD",
    );

    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, HEAD");
    expect(methodResponse.headers.get("cache-control")).toBe("no-store");
    expect(await methodResponse.text()).toBe("Method not allowed");
    await expectUnencodedResponse(legacyResponse, 404, "Not found");
    expect(legacyResponse.headers.get("content-type")).toBeNull();
    expect(legacyHeadResponse.status).toBe(404);
    expect(await legacyHeadResponse.text()).toBe("");
  });

  test("serves the standalone runner executable", async () => {
    await expectAsset(
      `${RUNNER_EXECUTABLE_PATH}?target=bun-linux-x64-baseline`,
      "application/octet-stream",
      runnerExecutable,
    );
  });

  test("serves the standalone runner supervisor", async () => {
    await expectAsset(
      `${RUNNER_SUPERVISOR_PATH}?target=bun-linux-x64-baseline`,
      "application/octet-stream",
      "standalone runner supervisor",
    );
  });

  test("protects user runner routes and does not expose removed callbacks", async () => {
    const collectionResponse = await sendRequest(RUNNERS_PATH);
    const setupResponse = await sendRequest(RUNNERS_PATH, undefined, "POST");
    const defaultResponse = await sendRequest(
      runnerDefaultPath("runner-id"),
      undefined,
      "POST",
    );
    const removedCallbackResponses = await Promise.all([
      sendRequest("/api/runner/register", undefined, "POST"),
      sendRequest("/api/runner/heartbeat", undefined, "POST"),
      sendRequest("/api/runner/work", undefined, "POST"),
    ]);
    const installerResponse = await sendRequest(
      `${RUNNER_INSTALLER_PATH}?token=qmr_unknown-token`,
    );

    expect(collectionResponse.status).toBe(401);
    expect(defaultResponse.status).toBe(401);
    expect(setupResponse.status).toBe(401);
    expect(removedCallbackResponses.every(({ status }) => status === 404)).toBe(
      true,
    );
    expect(installerResponse.status).toBe(404);
  });

  test("protects Brave Search key routes", async () => {
    expectResponseStatuses(
      await Promise.all([
        sendRequest(BRAVE_SEARCH_KEYS_PATH),
        sendRequest(BRAVE_SEARCH_KEYS_PATH, undefined, "POST"),
        sendRequest(`${BRAVE_SEARCH_KEYS_PATH}/key-id`, undefined, "DELETE"),
      ]),
      401,
    );
  });

  test("protects prompt routes", async () => {
    const promptIdPath = promptPath("prompt-id");
    const responses = await Promise.all([
      sendRequest(PROMPTS_PATH),
      sendRequest(PROMPTS_PATH, undefined, "POST"),
      sendRequest(promptIdPath),
      sendRequest(promptIdPath, undefined, "PUT"),
      sendRequest(promptIdPath, undefined, "DELETE"),
    ]);
    expectResponseStatuses(responses, 401);
  });

  test("protects global tool settings routing", async () => {
    await expectProtectedApiAndOutsidePath(
      [
        sendRequest(TOOL_SETTINGS_PATH),
        sendRequest(TOOL_SETTINGS_PATH, undefined, "PUT"),
      ],
      "/tool-settings",
    );
  });

  test("protects agent session routes", async () => {
    const responses = await Promise.all([
      sendRequest(SESSIONS_PATH),
      sendRequest(SESSIONS_PATH, undefined, "POST"),
      sendRequest(
        `${SESSION_MODELS_PATH}?provider=openai&credentialId=credential-id`,
      ),
      sendRequest(`${SESSIONS_PATH}/session-id`),
      sendRequest(`${SESSIONS_PATH}/session-id/compact`, undefined, "POST"),
      sendRequest(`${SESSIONS_PATH}/session-id/compaction`, undefined, "POST"),
      sendRequest(`${SESSIONS_PATH}/session-id/continue`, undefined, "POST"),
      sendRequest(`${SESSIONS_PATH}/session-id/messages`, undefined, "POST"),
      sendRequest(`${SESSIONS_PATH}/session-id/reassign`, undefined, "POST"),
      sendRequest(`${SESSIONS_PATH}/session-id/stop`, undefined, "POST"),
      sendRequest(runnerDirectoriesPath("runner-id"), undefined, "POST"),
    ]);

    expectResponseStatuses(responses, 401);
  });

  test("serves the authentication session endpoint", async () => {
    const response = await sendRequest("/api/auth/session");

    expect(response.ok).toBe(true);
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
    {
      callbackPath: undefined,
      credentialsPath: GENERIC_CREDENTIALS_PATH,
      name: "generic provider",
      oauthPath: undefined,
      outsidePath: "/generic/credentials",
    },
  ]) {
    test(`routes protected ${provider.name} requests`, async () => {
      const responses = await Promise.all([
        ...(provider.oauthPath === undefined
          ? []
          : [sendRequest(provider.oauthPath)]),
        ...(provider.callbackPath === undefined
          ? []
          : [sendRequest(provider.callbackPath)]),
        sendRequest(provider.credentialsPath),
        sendRequest(
          providerCredentialDefaultPath(
            provider.credentialsPath,
            "credential-id",
          ),
          undefined,
          "POST",
        ),
        sendRequest(
          `${provider.credentialsPath}/credential-id`,
          undefined,
          "DELETE",
        ),
      ]);
      expectResponseStatuses(responses, 401);
      expect((await sendRequest(provider.outsidePath)).status).toBe(404);
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
