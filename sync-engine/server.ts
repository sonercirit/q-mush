import { createHash } from "node:crypto";
import { brotliCompressSync, deflateSync } from "node:zlib";
import {
  API_BASE_PATH,
  APP_PATH,
  APP_SCRIPT_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  BRAVE_SEARCH_KEYS_PATH,
  FAVICON_PATH,
  GENERIC_CREDENTIALS_PATH,
  HOME_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  PROMPTS_PATH,
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
  RUNNER_DIRECTORIES_SEGMENT,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNER_SUPERVISOR_PATH,
  RUNNERS_PATH,
  SESSION_ATTACHMENT_FALLBACKS_PATH,
  SESSION_MODELS_PATH,
  SESSION_OPENROUTER_PROVIDERS_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
  TOOL_SETTINGS_PATH,
  WORKSPACES_PATH,
} from "../shared/routes.ts";
import { exportAccount } from "./account-export.ts";
import { readFavicon } from "./client-build.ts";
import { createMethodNotAllowedResponse } from "./http.ts";
import type { RenderedPages } from "./pages.ts";
import type { ProviderIntegration } from "./provider-integration.ts";
import type { RequestHandlerIntegrations } from "./server-integrations.ts";

const DEFAULT_Q_MUSH_PORT = 12_345;

export function readQmushPort(
  environment: Readonly<Record<string, string | undefined>>,
): string | number {
  const configuredPort = environment["PORT"]?.trim();
  return configuredPort === undefined || configuredPort.length === 0
    ? DEFAULT_Q_MUSH_PORT
    : configuredPort;
}

const CSS_HEADERS = { "content-type": "text/css; charset=utf-8" };
const FAVICON_HEADERS = {
  "cache-control": "public, max-age=86400, must-revalidate",
  "content-type": "image/svg+xml; charset=utf-8",
  "x-content-type-options": "nosniff",
};
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const JAVASCRIPT_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
};

type ContentEncoding = "br" | "deflate" | "gzip" | "zstd";
type ResponseEncoding = ContentEncoding | "identity";

interface PreparedBody {
  readonly compressed: Readonly<Record<ContentEncoding, ArrayBuffer>>;
  readonly identity: string;
  readonly identityByteLength: number;
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
    identityByteLength: body.byteLength,
  };
}

function preparedBodyByteLength(
  body: PreparedBody,
  encoding: ResponseEncoding,
): number {
  return encoding === "identity"
    ? body.identityByteLength
    : body.compressed[encoding].byteLength;
}

function acceptsEntityTag(request: Request, tag: string): boolean {
  const header = request.headers.get("if-none-match");
  const weakTag = tag.replace(/^W\//u, "");

  if (header === null) {
    return false;
  }

  for (const candidate of header.split(",")) {
    const value = candidate.trim();
    if (value === "*" || value.replace(/^W\//u, "") === weakTag) {
      return true;
    }
  }

  return false;
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

  if (request.method === "HEAD") {
    responseHeaders.set(
      "content-length",
      String(preparedBodyByteLength(body, encoding)),
    );
    if (encoding !== "identity") {
      responseHeaders.set("content-encoding", encoding);
    }
    return new Response(null, { headers: responseHeaders, status });
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

function createFaviconResponse(
  request: Request,
  body: PreparedBody,
  entityTag: string,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = createMethodNotAllowedResponse("GET, HEAD");
    response.headers.set("cache-control", "no-store");
    return response;
  }

  const headers = new Headers(FAVICON_HEADERS);
  headers.set("etag", entityTag);

  if (acceptsEntityTag(request, entityTag)) {
    headers.set("vary", "Accept-Encoding");
    return new Response(null, { headers, status: 304 });
  }

  return createTextResponse(request, body, headers);
}

interface ProviderRoutes {
  readonly credentials: string;
  readonly oauth?: string;
  readonly oauthCallback?: string;
}

function pathSegments(pathname: string, prefix: string): readonly string[] {
  return pathname.startsWith(prefix)
    ? pathname.slice(prefix.length).split("/")
    : [];
}

function routeItemId(segments: readonly string[]): string | undefined {
  const id = segments[0];
  return id === undefined || id.length === 0 ? undefined : id;
}

type SessionItemAction = (
  request: Request,
  id: string,
) => Promise<Response> | Response;

interface SessionItemRoutes {
  readonly compact: SessionItemAction;
  readonly compaction: SessionItemAction;
  readonly continue: SessionItemAction;
  readonly item: SessionItemAction;
  readonly message: SessionItemAction;
  readonly reassign: SessionItemAction;
  readonly stop: SessionItemAction;
}

function routeItemFallback(segments: readonly string[]): undefined {
  void segments;
  return undefined;
}

function routeItemRequest(
  segments: readonly string[],
  item: (id: string) => Promise<Response> | Response,
  nested: (id: string) => Promise<Response> | Response | undefined,
): Promise<Response> | Response | undefined {
  const id = routeItemId(segments);
  if (id === undefined) {
    routeItemFallback(segments);
    return undefined;
  }
  return segments.length === 1 ? item(id) : nested(id);
}

function routeSessionItem(
  segments: readonly string[],
  request: Request,
  sessions: SessionItemRoutes,
): Promise<Response> | Response | undefined {
  return routeItemRequest(
    segments,
    (id) => sessions.item(request, id),
    (id) => {
      if (segments.length !== 2) return undefined;
      const route = segments[1];
      const routes: Readonly<
        Record<
          | "compact"
          | "compaction"
          | "continue"
          | "messages"
          | "reassign"
          | "stop",
          () => Promise<Response> | Response
        >
      > = {
        compact: () => sessions.compact(request, id),
        compaction: () => sessions.compaction(request, id),
        continue: () => sessions.continue(request, id),
        messages: () => sessions.message(request, id),
        reassign: () => sessions.reassign(request, id),
        stop: () => sessions.stop(request, id),
      };
      const handler =
        route === "compact" ||
        route === "compaction" ||
        route === "continue" ||
        route === "messages" ||
        route === "reassign" ||
        route === "stop"
          ? routes[route]
          : undefined;
      return handler?.();
    },
  );
}

interface ItemRouteActions {
  readonly default?: (id: string) => Promise<Response> | Response;
  readonly item: (id: string) => Promise<Response> | Response;
  readonly scopes?: (id: string) => Promise<Response> | Response;
  readonly sessionReassignment?: (id: string) => Promise<Response> | Response;
}

function routeItemSegments(
  segments: readonly string[],
  actions: ItemRouteActions,
): Promise<Response> | Response | undefined {
  return routeItemRequest(segments, actions.item, (id) => {
    if (segments.length === 2) {
      const route = segments[1];
      const routes: Readonly<
        Record<
          "default" | "scopes" | "session-reassignment",
          ((id: string) => Promise<Response> | Response) | undefined
        >
      > = {
        default: actions.default,
        scopes: actions.scopes,
        "session-reassignment": actions.sessionReassignment,
      };
      const handler =
        route === "default" ||
        route === "scopes" ||
        route === "session-reassignment"
          ? routes[route]
          : undefined;
      return handler?.(id);
    }
    return undefined;
  });
}

function routeProviderRequest(
  pathname: string,
  request: Request,
  integration: ProviderIntegration,
  routes: ProviderRoutes,
): Promise<Response> | Response | undefined {
  if (routes.oauth !== undefined && pathname === routes.oauth) {
    return integration.begin(request);
  }

  if (routes.oauthCallback !== undefined && pathname === routes.oauthCallback) {
    return integration.complete(request);
  }

  if (pathname === routes.credentials) {
    return integration.credentials(request);
  }

  const credentialSegments = pathSegments(pathname, `${routes.credentials}/`);
  const credentialId = credentialSegments[0];
  if (credentialId !== undefined && credentialSegments[1] === "quota") {
    if (credentialSegments.length === 2) {
      return integration.quota(request, credentialId);
    }
    if (credentialSegments.length === 3) {
      return credentialSegments[2] === "reset"
        ? integration.resetQuota(request, credentialId)
        : credentialSegments[2] === "threshold"
          ? integration.setQuotaThreshold(request, credentialId)
          : undefined;
    }
  }

  return routeItemSegments(credentialSegments, {
    default: (credentialId) => integration.setDefault(request, credentialId),
    item: (credentialId) => integration.remove(request, credentialId),
    scopes: (credentialId) => integration.setScopes(request, credentialId),
    sessionReassignment: (credentialId) =>
      integration.reassignSessions(request, credentialId),
  });
}

export function createRequestHandler(
  clientJavaScript: string,
  stylesheet: string,
  pages: RenderedPages,
  integrations: RequestHandlerIntegrations,
): (request: Request) => Promise<Response> {
  const { braveSearch, database, generic, googleAuth, openAi } = integrations;
  const { openRouter, prompts, runnerExecutables, runners } = integrations;
  const { sessions, toolSettings, workspaces } = integrations;
  const appPage = prepareBody(pages.app);
  const browserBundle = prepareBody(clientJavaScript);
  const faviconSource = readFavicon();
  const favicon = prepareBody(faviconSource);
  const faviconEntityTag = `W/"${createHash("sha256").update(faviconSource).digest("hex")}"`;
  const homePage = prepareBody(pages.home);
  const notFound = prepareBody("Not found");
  const styles = prepareBody(stylesheet);

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith(`${API_BASE_PATH}/`)) {
      if (pathname === RUNNER_ACCOUNT_EXPORT_PATH) {
        if (request.method !== "GET")
          return createMethodNotAllowedResponse("GET");
        const account = runners.runnerAccount(request);
        if (account === undefined)
          return new Response("Unauthorized", { status: 401 });
        const exported = exportAccount(database, account.userId);
        return Response.json({
          entities: exported.entities,
          entityCounts: exported.entityCounts,
          frontier: exported.frontier,
          manifest: exported.manifest,
          records: exported.records,
        });
      }
      if (pathname.startsWith(`${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/`)) {
        if (request.method !== "GET")
          return createMethodNotAllowedResponse("GET");
        const account = runners.runnerAccount(request);
        if (account === undefined)
          return new Response("Unauthorized", { status: 401 });
        const digest = pathname.slice(
          RUNNER_ACCOUNT_EXPORT_BLOB_PATH.length + 1,
        );
        const blob = exportAccount(database, account.userId).blobs.find(
          (entry) => entry.digest === digest,
        );
        return blob === undefined
          ? new Response("Not found", { status: 404 })
          : new Response(Uint8Array.fromBase64(blob.data), {
              headers: {
                "content-length": String(blob.size),
                "content-type": "application/octet-stream",
              },
            });
      }
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
        scopes: (runnerId) => runners.setScopes(request, runnerId),
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

      if (pathname === TOOL_SETTINGS_PATH) {
        return toolSettings.collection(request);
      }

      if (pathname === PROMPTS_PATH) {
        return prompts.collection(request);
      }

      if (pathname === WORKSPACES_PATH) {
        return workspaces.collection(request);
      }

      const workspaceResponse = routeItemSegments(
        pathSegments(pathname, `${WORKSPACES_PATH}/`),
        {
          default: (workspaceId) => workspaces.setDefault(request, workspaceId),
          item: (workspaceId) => workspaces.item(request, workspaceId),
        },
      );
      if (workspaceResponse !== undefined) {
        return workspaceResponse;
      }

      const promptResponse = routeItemSegments(
        pathSegments(pathname, `${PROMPTS_PATH}/`),
        {
          item: (promptId) => prompts.item(request, promptId),
        },
      );

      if (promptResponse !== undefined) {
        return promptResponse;
      }

      if (pathname === BRAVE_SEARCH_KEYS_PATH) {
        return braveSearch.keys(request);
      }

      const braveSearchKeyResponse = routeItemSegments(
        pathSegments(pathname, `${BRAVE_SEARCH_KEYS_PATH}/`),
        {
          item: (keyId) => braveSearch.remove(request, keyId),
          scopes: (keyId) => braveSearch.setScopes(request, keyId),
        },
      );
      if (braveSearchKeyResponse !== undefined) {
        return braveSearchKeyResponse;
      }

      if (
        pathname === SESSION_ATTACHMENT_FALLBACKS_PATH &&
        sessions.attachmentFallbacks !== undefined
      ) {
        return sessions.attachmentFallbacks(request);
      }

      if (pathname === SESSION_MODELS_PATH) {
        return sessions.models(request);
      }

      if (pathname === SESSION_OPENROUTER_PROVIDERS_PATH) {
        return sessions.openRouterProviders(request);
      }

      const sessionPathPrefix = `${SESSIONS_PATH}/`;

      if (pathname.startsWith(sessionPathPrefix)) {
        const segments = pathname.slice(sessionPathPrefix.length).split("/");
        const response = routeSessionItem(segments, request, sessions);
        if (response !== undefined) return response;
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

      if (generic !== undefined) {
        const genericResponse = routeProviderRequest(
          pathname,
          request,
          generic,
          {
            credentials: GENERIC_CREDENTIALS_PATH,
          },
        );
        if (genericResponse !== undefined) {
          return genericResponse;
        }
      }
    }

    if (pathname === FAVICON_PATH) {
      return createFaviconResponse(request, favicon, faviconEntityTag);
    }

    if (pathname === HOME_PATH) {
      return createTextResponse(request, homePage, HTML_HEADERS);
    }

    if (pathname === APP_PATH) {
      return createTextResponse(request, appPage, HTML_HEADERS);
    }

    if (pathname === APP_SCRIPT_PATH)
      return createTextResponse(request, browserBundle, JAVASCRIPT_HEADERS);

    if (pathname === RUNNER_INSTALLER_PATH) return runners.installer(request);

    if (pathname === RUNNER_EXECUTABLE_PATH)
      return runnerExecutables.serve(request);
    if (pathname === RUNNER_SUPERVISOR_PATH)
      return runnerExecutables.serveSupervisor(request);
    if (pathname === STYLESHEET_PATH) {
      return createTextResponse(request, styles, CSS_HEADERS);
    }

    return createTextResponse(request, notFound, undefined, 404);
  };
}

export {
  buildClientJavaScript,
  buildClientStylesheet,
} from "./client-assets.ts";
