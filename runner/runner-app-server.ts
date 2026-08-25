export interface RunnerAppRelease {
  readonly files: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
  readonly shell: string;
}

const HASHED_ASSET_PATTERN = /\.[a-f\d]{3,64}\.(?:css|js)$/u;

function contentType(pathname: string): string {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export interface RunnerAppPairing {
  readonly browserGrant: string;
  readonly code: string;
}

import type { ActiveViewReader } from "../shared/active-view.ts";

export interface RunnerAppViewSource extends ActiveViewReader {
  readonly progress: () => { readonly state: "joining" | "ready" };
  readonly readBlob?: (digest: string) => Blob;
}

export function createRunnerAppHandler(
  release: RunnerAppRelease,
  origin: string,
  options?: {
    readonly pairing: RunnerAppPairing;
    readonly views?: RunnerAppViewSource;
  },
): (request: Request) => Response {
  const expected = new URL(origin);
  if (
    expected.protocol !== "http:" ||
    (expected.hostname !== "127.0.0.1" && expected.hostname !== "[::1]")
  ) {
    throw new Error("The runner app origin must be HTTP loopback");
  }
  return (request) => {
    const url = new URL(request.url);
    if (url.origin !== expected.origin) {
      return new Response("Misdirected request", { status: 421 });
    }
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== expected.origin) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "POST" && url.pathname === "/api/local/pair") {
      if (options?.pairing === undefined) {
        return new Response("Not found", { status: 404 });
      }
      if (
        request.headers.get("x-q-mush-pairing-code") !== options.pairing.code
      ) {
        return new Response("Pairing rejected", { status: 403 });
      }
      return new Response(null, {
        headers: {
          "set-cookie": `qm_browser=${options.pairing.browserGrant}; HttpOnly; SameSite=Strict; Path=/`,
        },
        status: 204,
      });
    }
    if (
      options?.pairing !== undefined &&
      request.headers.get("cookie")?.split(";", 1)[0] !==
        `qm_browser=${options.pairing.browserGrant}`
    ) {
      return new Response("Pairing required", { status: 401 });
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/local/blob/")
    ) {
      if (options?.views?.readBlob === undefined) {
        return new Response("Not found", { status: 404 });
      }
      const digest = url.pathname.slice("/api/local/blob/".length);
      if (!/^[a-f\d]{64}$/u.test(digest)) {
        return new Response("Invalid blob digest", { status: 400 });
      }
      try {
        return new Response(options.views.readBlob(digest), {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/local/view") {
      if (options?.views === undefined) {
        return Response.json({ error: "view_unavailable" }, { status: 404 });
      }
      const entity = url.searchParams.get("entity");
      const limit = Number(url.searchParams.get("limit"));
      if (
        entity === null ||
        !["agent_sessions", "agent_messages"].includes(entity)
      ) {
        return Response.json({ error: "invalid_view" }, { status: 400 });
      }
      try {
        return Response.json({
          origin: "runner",
          ...options.views.readView(
            entity,
            limit,
            url.searchParams.get("sessionId") ?? undefined,
          ),
        });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "view_failed" },
          { status: options.views.progress().state === "ready" ? 400 : 503 },
        );
      }
    }
    if (request.method === "GET" && url.pathname === "/api/local/status") {
      return Response.json({
        complete: options?.views?.progress().state === "ready",
        mutations: false,
        origin: "runner",
        partial: true,
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/" || url.pathname === "/app") {
      return new Response(request.method === "HEAD" ? null : release.shell, {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const name = url.pathname.slice(1);
    const bytes = release.files[name];
    if (bytes === undefined) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : new Blob([bytes]), {
      headers: {
        "cache-control": HASHED_ASSET_PATTERN.test(name)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": contentType(name),
        "x-content-type-options": "nosniff",
      },
    });
  };
}
