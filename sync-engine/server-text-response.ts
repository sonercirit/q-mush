import { brotliCompressSync, deflateSync } from "node:zlib";

import { createMethodNotAllowedResponse } from "./http.ts";

export const CSS_HEADERS = { "content-type": "text/css; charset=utf-8" };
const FAVICON_HEADERS = {
  "cache-control": "public, max-age=86400, must-revalidate",
  "content-type": "image/svg+xml; charset=utf-8",
  "x-content-type-options": "nosniff",
};
export const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
export const JAVASCRIPT_HEADERS = {
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

export function prepareBody(identity: string): PreparedBody {
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

export function createTextResponse(
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

export function createFaviconResponse(
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
