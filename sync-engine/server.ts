import { createHash } from "node:crypto";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { build } from "vite";
import { PWA_MANIFEST } from "../shared/pwa.ts";
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
  MANIFEST_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  PWA_ICON_192_PATH,
  PWA_ICON_512_MASKABLE_PATH,
  PWA_ICON_512_PATH,
  RUNNER_DIRECTORIES_SEGMENT,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNERS_PATH,
  SERVICE_WORKER_PATH,
  SESSION_MODELS_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "../shared/routes.ts";
import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import {
  clientBuildConfiguration,
  createClientPlugins,
} from "./client-build.ts";
import type { OpenAiIntegration } from "./openai.ts";
import type { OpenRouterIntegration } from "./openrouter.ts";
import type { RenderedPages } from "./pages.ts";
import type { ProviderIntegration } from "./provider-integration.ts";
import { createPwaIcon } from "./pwa-icon.ts";
import type { RunnerExecutableProvider } from "./runner-executable.ts";
import type { RunnerIntegration } from "./runners.ts";
import { createServiceWorkerJavaScript } from "./service-worker.ts";
import type { SessionIntegration } from "./sessions.ts";

const CSS_HEADERS = { "content-type": "text/css; charset=utf-8" };
const HTML_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "text/html; charset=utf-8",
};
const IMMUTABLE_ASSET_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
};
const JAVASCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
};
const MANIFEST_HEADERS = {
  "cache-control": "public, max-age=3600",
  "content-type": "application/manifest+json; charset=utf-8",
};
const SERVICE_WORKER_HEADERS = {
  "cache-control": "no-cache, no-store, must-revalidate",
  "content-type": "text/javascript; charset=utf-8",
  "service-worker-allowed": "/",
};

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

function pathSegments(pathname: string, prefix: string): readonly string[] {
  return pathname.startsWith(prefix)
    ? pathname.slice(prefix.length).split("/")
    : [];
}

interface ItemRouteActions {
  readonly default?: (id: string) => Promise<Response> | Response;
  readonly item: (id: string) => Promise<Response> | Response;
}

function routeItemSegments(
  segments: readonly string[],
  actions: ItemRouteActions,
): Promise<Response> | Response | undefined {
  const id = segments[0];
  if (id === undefined || id.length === 0) {
    return undefined;
  }

  if (segments.length === 1) {
    return actions.item(id);
  }

  return segments.length === 2 && segments[1] === "default"
    ? actions.default?.(id)
    : undefined;
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

  return routeItemSegments(pathSegments(pathname, `${routes.credentials}/`), {
    default: (credentialId) => integration.setDefault(request, credentialId),
    item: (credentialId) => integration.remove(request, credentialId),
  });
}

export function createRequestHandler(
  clientJavaScript: string,
  stylesheet: string,
  pages: RenderedPages,
  googleAuth: GoogleAuth,
  openAi: OpenAiIntegration,
  openRouter: OpenRouterIntegration,
  braveSearch: BraveSearchSkill,
  runners: RunnerIntegration,
  sessions: SessionIntegration,
  runnerExecutables: RunnerExecutableProvider,
): (request: Request) => Promise<Response> {
  const appPage = prepareBody(pages.app);
  const browserBundle = prepareBody(clientJavaScript);
  const homePage = prepareBody(pages.home);
  const manifestJson = JSON.stringify(PWA_MANIFEST);
  const manifest = prepareBody(manifestJson);
  const notFound = prepareBody("Not found");
  const shellVersion = createHash("sha256")
    .update("q-mush-pwa-v1\0")
    .update(clientJavaScript)
    .update("\0")
    .update(stylesheet)
    .update("\0")
    .update(pages.app)
    .update("\0")
    .update(manifestJson)
    .digest("hex");
  const serviceWorker = prepareBody(
    createServiceWorkerJavaScript(shellVersion),
  );
  const styles = prepareBody(stylesheet);
  const icons = new Map<string, Uint8Array>([
    [PWA_ICON_192_PATH, createPwaIcon(192)],
    [PWA_ICON_512_PATH, createPwaIcon(512)],
    [PWA_ICON_512_MASKABLE_PATH, createPwaIcon(512, true)],
  ]);

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

      const runnerSegments = pathSegments(pathname, `${RUNNERS_PATH}/`);
      const runnerResponse = routeItemSegments(runnerSegments, {
        default: (runnerId) => runners.setDefault(request, runnerId),
        item: (runnerId) => runners.remove(request, runnerId),
      });

      if (runnerResponse !== undefined) {
        return runnerResponse;
      }

      const runnerId = runnerSegments[0];
      if (
        runnerId !== undefined &&
        runnerSegments.length === 2 &&
        runnerSegments[1] === RUNNER_DIRECTORIES_SEGMENT
      ) {
        return sessions.directories(request, runnerId);
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

    if (pathname === MANIFEST_PATH) {
      return createTextResponse(request, manifest, MANIFEST_HEADERS);
    }

    if (pathname === SERVICE_WORKER_PATH) {
      return createTextResponse(request, serviceWorker, SERVICE_WORKER_HEADERS);
    }

    const icon = icons.get(pathname);
    if (icon !== undefined) {
      return new Response(toArrayBuffer(icon), {
        headers: {
          ...IMMUTABLE_ASSET_HEADERS,
          "content-type": "image/png",
          "x-content-type-options": "nosniff",
        },
      });
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

interface ViteClientAssets {
  readonly javaScript: string;
  readonly stylesheet: string;
}

function isViteOutput(
  value: Awaited<ReturnType<typeof build>>,
): value is Extract<Awaited<ReturnType<typeof build>>, { output: unknown }> {
  return !Array.isArray(value) && "output" in value;
}

function viteOutputs(
  result: Awaited<ReturnType<typeof build>>,
): readonly Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>[] {
  return Array.isArray(result)
    ? result.filter(isViteOutput)
    : isViteOutput(result)
      ? [result]
      : [];
}

function readViteClientAssets(
  result: Awaited<ReturnType<typeof build>>,
): ViteClientAssets {
  const builds = viteOutputs(result);

  if (builds.length === 0) {
    throw new Error("The Vite browser build did not return output");
  }

  let javaScript: string | undefined;
  let stylesheet: string | undefined;

  for (const { output: outputs } of builds) {
    for (const output of outputs) {
      if (output.type === "chunk" && output.isEntry) {
        javaScript = output.code;
      } else if (output.type === "asset" && output.fileName.endsWith(".css")) {
        stylesheet =
          typeof output.source === "string"
            ? output.source
            : new TextDecoder().decode(output.source);
      }
    }
  }

  if (javaScript === undefined || stylesheet === undefined) {
    throw new Error(
      "The Vite browser build did not produce JavaScript and CSS",
    );
  }

  return { javaScript, stylesheet };
}

let clientAssets: Promise<ViteClientAssets> | undefined;

function buildClientAssets(): Promise<ViteClientAssets> {
  clientAssets ??= build({
    build: {
      ...clientBuildConfiguration,
      write: false,
    },
    configFile: false,
    logLevel: "silent",
    plugins: createClientPlugins(),
  }).then(readViteClientAssets);
  return clientAssets;
}

export async function buildClientStylesheet(): Promise<string> {
  return (await buildClientAssets()).stylesheet;
}

export async function buildClientJavaScript(): Promise<string> {
  return (await buildClientAssets()).javaScript;
}
