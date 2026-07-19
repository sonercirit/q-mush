import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

export function appendCookies(
  headers: Headers,
  cookies: readonly string[],
): void {
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
}

export function createCookie(
  name: string,
  value: string,
  maxAge: number,
  path: string,
  secure: boolean,
): string {
  const secureAttribute = secure ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; Max-Age=${String(maxAge)}; Path=${path}; SameSite=Lax${secureAttribute}`;
}

export function createJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

export function createMethodNotAllowedResponse(
  allowedMethod: string,
): Response {
  return new Response("Method not allowed", {
    headers: {
      allow: allowedMethod,
      "content-type": "text/plain; charset=utf-8",
    },
    status: 405,
  });
}

export function createRedirect(
  location: URL,
  cookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location: location.toString(),
    "referrer-policy": "no-referrer",
  });
  appendCookies(headers, cookies);

  return new Response(null, { headers, status: 302 });
}

export function valuesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function readCookie(request: Request, name: string): string | undefined {
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
