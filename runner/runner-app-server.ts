import { timingSafeEqual } from "node:crypto";
import { ACCOUNT_EXPORT_ENTITIES } from "../shared/account-export.ts";
import { activeViewQuery } from "../shared/active-view-query.ts";
import type { ActiveViewReader } from "../shared/active-view.ts";
import { isSha256Digest } from "../shared/digest.ts";
import type { AccountExportRetryProgress } from "./runner-account-export-client.ts";
import type { AnonymousRunnerPairing } from "./runner-anonymous-identity.ts";

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

export type RunnerAppPairing = AnonymousRunnerPairing;

export interface RunnerAppViewSource extends ActiveViewReader {
  readonly progress: () => Partial<AccountExportRetryProgress> & {
    readonly state: "joining" | "ready";
  };
  readonly readBlob?: (digest: string) => Blob;
}

function isExportEntity(entity: string): boolean {
  return ACCOUNT_EXPORT_ENTITIES.some((candidate) => candidate === entity);
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
  let paired = false;
  let failedPairings = 0;
  const equalSecret = (candidate: string | null, secret: string): boolean => {
    if (candidate === null) return false;
    const actual = Buffer.from(candidate);
    const expectedSecret = Buffer.from(secret);
    return (
      actual.length === expectedSecret.length &&
      timingSafeEqual(actual, expectedSecret)
    );
  };
  const browserCookie = (header: string | null): string | null =>
    header
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("qm_browser="))
      ?.slice(11) ?? null;
  return (request) => {
    const url = new URL(request.url);
    if (url.origin !== expected.origin) {
      return new Response("Misdirected request", { status: 421 });
    }
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== expected.origin) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "GET" && url.pathname === "/api/local/pair") {
      return options?.pairing === undefined
        ? new Response("Not found", { status: 404 })
        : Response.json({ transcript: options.pairing.transcript });
    }
    if (request.method === "POST" && url.pathname === "/api/local/pair") {
      if (options?.pairing === undefined) {
        return new Response("Not found", { status: 404 });
      }
      const valid =
        !paired &&
        failedPairings < 5 &&
        Date.now() <= options.pairing.expiresAt &&
        equalSecret(
          request.headers.get("x-q-mush-pairing-code"),
          options.pairing.code,
        ) &&
        equalSecret(
          request.headers.get("x-q-mush-pairing-transcript"),
          options.pairing.transcript,
        );
      if (!valid) {
        failedPairings += 1;
        return new Response("Pairing rejected", { status: 403 });
      }
      paired = true;
      return new Response(null, {
        headers: {
          "set-cookie": `qm_browser=${options.pairing.browserGrant}; HttpOnly; SameSite=Strict; Path=/`,
        },
        status: 204,
      });
    }
    const hasBrowserGrant =
      options?.pairing === undefined ||
      equalSecret(
        browserCookie(request.headers.get("cookie")),
        options.pairing.browserGrant,
      );
    const browserShell =
      request.method === "GET" || request.method === "HEAD"
        ? url.pathname === "/" || url.pathname === "/app"
        : false;
    if (!hasBrowserGrant && !browserShell) {
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
      if (!isSha256Digest(digest)) {
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
      const { entity, limit } = activeViewQuery(url);
      if (entity === null || !isExportEntity(entity)) {
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
      const progress = options?.views?.progress();
      return Response.json({
        complete: progress?.state === "ready",
        ...(progress?.elapsedMilliseconds === undefined
          ? {}
          : {
              retry: {
                elapsedMilliseconds: progress.elapsedMilliseconds,
                previousRevision: progress.previousRevision,
                restartCount: progress.restartCount,
                revision: progress.revision,
              },
            }),
        mutations: false,
        origin: "runner",
        partial: true,
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/" || url.pathname === "/app") {
      return new Response(request.method === "HEAD" ? null : release.shell, {
        headers: {
          "cache-control": "no-cache",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const name = url.pathname.slice(1);
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype" ||
      !Object.hasOwn(release.files, name)
    )
      return new Response("Not found", { status: 404 });
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
