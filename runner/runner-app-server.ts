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

export function createRunnerAppHandler(
  release: RunnerAppRelease,
  origin: string,
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
