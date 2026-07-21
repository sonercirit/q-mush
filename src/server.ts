import { fileURLToPath } from "node:url";
import { brotliCompressSync, deflateSync } from "node:zlib";
import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import { readBuildArtifact } from "./build.ts";
import type { OpenAiIntegration } from "./openai.ts";
import type { OpenRouterIntegration } from "./openrouter.ts";
import { renderAppPage, renderHomePage } from "./pages.tsx";
import type { ProviderIntegration } from "./provider-integration.ts";
import {
  API_BASE_PATH,
  APP_PATH,
  APP_SCRIPT_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  BRAVE_SEARCH_KEYS_PATH,
  HOME_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  RUNNER_DIRECTORIES_SEGMENT,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNERS_PATH,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "./routes.ts";
import type { RunnerExecutableProvider } from "./runner-executable.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionIntegration } from "./sessions.ts";

const CSS_HEADERS = { "content-type": "text/css; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const JAVASCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
};
const TAILWIND_CLI_PATH = fileURLToPath(
  new URL(
    "dist/index.mjs",
    import.meta.resolve("@tailwindcss/cli/package.json"),
  ),
);

type ContentEncoding = "br" | "deflate" | "gzip" | "zstd";
type ResponseEncoding = ContentEncoding | "identity";

interface PreparedBody {
  readonly compressed: Readonly<Record<ContentEncoding, ArrayBuffer>>;
  readonly identity: string;
}

const CONTENT_ENCODINGS: readonly ContentEncoding[] = [
  "zstd",
  "br",
  "gzip",
  "deflate",
];

function parseEncodingPreferences(header: string): ReadonlyMap<string, number> {
  const preferences = new Map<string, number>();

  for (const item of header.split(",")) {
    const [rawEncoding = "", ...parameters] = item.split(";");
    const encoding = rawEncoding.trim().toLowerCase();
    let quality = 1;

    for (const parameter of parameters) {
      const separatorIndex = parameter.indexOf("=");

      if (separatorIndex < 0) {
        continue;
      }

      const name = parameter.slice(0, separatorIndex).trim().toLowerCase();

      if (name === "q") {
        const value = Number(parameter.slice(separatorIndex + 1).trim());
        quality =
          Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
      }
    }

    if (encoding.length > 0) {
      preferences.set(encoding, quality);
    }
  }

  return preferences;
}

function selectResponseEncoding(
  header: string | null,
): ResponseEncoding | undefined {
  if (header === null || header.trim().length === 0) {
    return "identity";
  }

  const preferences = parseEncodingPreferences(header);
  const wildcardQuality = preferences.get("*") ?? 0;
  let bestEncoding: ResponseEncoding | undefined;
  let bestQuality = 0;

  for (const encoding of CONTENT_ENCODINGS) {
    const quality = preferences.get(encoding) ?? wildcardQuality;

    if (quality > bestQuality) {
      bestEncoding = encoding;
      bestQuality = quality;
    }
  }

  const identityQuality =
    preferences.get("identity") ?? (preferences.get("*") === 0 ? 0 : 1);

  if (identityQuality > bestQuality) {
    return "identity";
  }

  return bestEncoding;
}

function toArrayBuffer(body: Uint8Array): ArrayBuffer {
  return new Uint8Array(body).buffer;
}

function prepareBody(identity: string): PreparedBody {
  const body = new TextEncoder().encode(identity);

  return {
    compressed: {
      br: toArrayBuffer(brotliCompressSync(body)),
      deflate: toArrayBuffer(deflateSync(body)),
      gzip: toArrayBuffer(Bun.gzipSync(body)),
      zstd: toArrayBuffer(Bun.zstdCompressSync(body)),
    },
    identity,
  };
}

function createTextResponse(
  request: Request,
  body: PreparedBody,
  headers?: HeadersInit,
  status = 200,
): Response {
  const responseHeaders = new Headers(headers);
  const encoding = selectResponseEncoding(
    request.headers.get("accept-encoding"),
  );
  responseHeaders.set("vary", "Accept-Encoding");

  if (encoding === undefined) {
    return new Response(null, { headers: responseHeaders, status: 406 });
  }

  if (encoding === "identity") {
    return new Response(body.identity, { headers: responseHeaders, status });
  }

  responseHeaders.set("content-encoding", encoding);
  return new Response(body.compressed[encoding], {
    headers: responseHeaders,
    status,
  });
}

interface ProviderRoutes {
  readonly credentials: string;
  readonly oauth: string;
  readonly oauthCallback: string;
}

function routeProviderRequest(
  pathname: string,
  request: Request,
  integration: ProviderIntegration,
  routes: ProviderRoutes,
): Promise<Response> | Response | undefined {
  if (pathname === routes.oauth) {
    return integration.begin(request);
  }

  if (pathname === routes.oauthCallback) {
    return integration.complete(request);
  }

  if (pathname === routes.credentials) {
    return integration.credentials(request);
  }

  const credentialPathPrefix = `${routes.credentials}/`;

  if (pathname.startsWith(credentialPathPrefix)) {
    const credentialId = pathname.slice(credentialPathPrefix.length);

    if (credentialId.length > 0 && !credentialId.includes("/")) {
      return integration.remove(request, credentialId);
    }
  }

  return undefined;
}

export function createRequestHandler(
  clientJavaScript: string,
  stylesheet: string,
  googleAuth: GoogleAuth,
  openAi: OpenAiIntegration,
  openRouter: OpenRouterIntegration,
  braveSearch: BraveSearchSkill,
  runners: RunnerIntegration,
  sessions: SessionIntegration,
  runnerExecutables: RunnerExecutableProvider,
): (request: Request) => Promise<Response> {
  const appPage = prepareBody(renderAppPage());
  const browserBundle = prepareBody(clientJavaScript);
  const homePage = prepareBody(renderHomePage());
  const notFound = prepareBody("Not found");
  const styles = prepareBody(stylesheet);

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith(`${API_BASE_PATH}/`)) {
      if (pathname === AUTH_GOOGLE_PATH) {
        return googleAuth.begin(request);
      }

      if (pathname === AUTH_GOOGLE_CALLBACK_PATH) {
        return googleAuth.complete(request);
      }

      if (pathname === AUTH_LOGOUT_PATH) {
        return googleAuth.logout(request);
      }

      if (pathname === AUTH_SESSION_PATH) {
        return googleAuth.session(request);
      }

      if (pathname === RUNNERS_PATH) {
        return runners.collection(request);
      }

      const runnerPathPrefix = `${RUNNERS_PATH}/`;

      if (pathname.startsWith(runnerPathPrefix)) {
        const segments = pathname.slice(runnerPathPrefix.length).split("/");
        const runnerId = segments[0];

        if (runnerId !== undefined && runnerId.length > 0) {
          if (segments.length === 1) {
            return runners.remove(request, runnerId);
          }

          if (
            segments.length === 2 &&
            segments[1] === RUNNER_DIRECTORIES_SEGMENT
          ) {
            return sessions.directories(request, runnerId);
          }
        }
      }

      if (pathname === SESSIONS_PATH) {
        return sessions.collection(request);
      }

      if (pathname === BRAVE_SEARCH_KEYS_PATH) {
        return braveSearch.keys(request);
      }

      const braveSearchKeyPrefix = `${BRAVE_SEARCH_KEYS_PATH}/`;

      if (pathname.startsWith(braveSearchKeyPrefix)) {
        const keyId = pathname.slice(braveSearchKeyPrefix.length);

        if (keyId.length > 0 && !keyId.includes("/")) {
          return braveSearch.remove(request, keyId);
        }
      }

      if (pathname === SESSION_MODELS_PATH) {
        return sessions.models(request);
      }

      const sessionPathPrefix = `${SESSIONS_PATH}/`;

      if (pathname.startsWith(sessionPathPrefix)) {
        const segments = pathname.slice(sessionPathPrefix.length).split("/");
        const sessionId = segments[0];

        if (sessionId !== undefined && sessionId.length > 0) {
          if (segments.length === 1) {
            return sessions.item(request, sessionId);
          }

          if (segments.length === 2) {
            switch (segments[1]) {
              case "compact":
                return sessions.compact(request, sessionId);
              case "compaction":
                return sessions.compaction(request, sessionId);
              case "continue":
                return sessions.continue(request, sessionId);
              case "messages":
                return sessions.message(request, sessionId);
              case "stop":
                return sessions.stop(request, sessionId);
              case undefined:
              default:
                break;
            }
          }
        }
      }

      const openAiResponse = routeProviderRequest(pathname, request, openAi, {
        credentials: OPENAI_CREDENTIALS_PATH,
        oauth: OPENAI_OAUTH_PATH,
        oauthCallback: OPENAI_OAUTH_CALLBACK_PATH,
      });

      if (openAiResponse !== undefined) {
        return openAiResponse;
      }

      const openRouterResponse = routeProviderRequest(
        pathname,
        request,
        openRouter,
        {
          credentials: OPENROUTER_CREDENTIALS_PATH,
          oauth: OPENROUTER_OAUTH_PATH,
          oauthCallback: OPENROUTER_OAUTH_CALLBACK_PATH,
        },
      );

      if (openRouterResponse !== undefined) {
        return openRouterResponse;
      }
    }

    if (pathname === HOME_PATH) {
      return createTextResponse(request, homePage, HTML_HEADERS);
    }

    if (pathname === APP_PATH) {
      return createTextResponse(request, appPage, HTML_HEADERS);
    }

    if (pathname === APP_SCRIPT_PATH) {
      return createTextResponse(request, browserBundle, JAVASCRIPT_HEADERS);
    }

    if (pathname === RUNNER_INSTALLER_PATH) {
      return runners.installer(request);
    }

    if (pathname === RUNNER_EXECUTABLE_PATH) {
      return runnerExecutables.serve(request);
    }

    if (pathname === STYLESHEET_PATH) {
      return createTextResponse(request, styles, CSS_HEADERS);
    }

    return createTextResponse(request, notFound, undefined, 404);
  };
}

export async function buildClientStylesheet(): Promise<string> {
  const command = [
    process.execPath,
    TAILWIND_CLI_PATH,
    "--input",
    fileURLToPath(new URL("styles.css", import.meta.url)),
  ];

  if (Bun.env.NODE_ENV === "production") {
    command.push("--minify");
  }

  const buildProcess = Bun.spawn(command, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stylesheet, standardError] = await Promise.all([
    buildProcess.exited,
    new Response(buildProcess.stdout).text(),
    new Response(buildProcess.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Could not build the stylesheet:\n${standardError.trim()}`);
  }

  if (stylesheet.length === 0) {
    throw new Error("The stylesheet build did not produce CSS");
  }

  return stylesheet;
}

async function buildJavaScript(
  entrypoint: string,
  target: "browser",
  label: string,
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entrypoint, import.meta.url))],
    format: "esm",
    minify: Bun.env.NODE_ENV === "production",
    target,
  });

  return readBuildArtifact(label, result).text();
}

export function buildClientJavaScript(): Promise<string> {
  return buildJavaScript("client.tsx", "browser", "browser app");
}
