import { fileURLToPath } from "node:url";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { renderAppPage, renderHomePage } from "./pages.tsx";
import {
  APP_PATH,
  APP_SCRIPT_PATH,
  HOME_PATH,
  STYLESHEET_PATH,
} from "./routes.ts";

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

export function createRequestHandler(
  clientJavaScript: string,
  stylesheet: string,
): (request: Request) => Response {
  const appPage = prepareBody(renderAppPage());
  const browserBundle = prepareBody(clientJavaScript);
  const homePage = prepareBody(renderHomePage());
  const notFound = prepareBody("Not found");
  const styles = prepareBody(stylesheet);

  return (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === HOME_PATH) {
      return createTextResponse(request, homePage, HTML_HEADERS);
    }

    if (pathname === APP_PATH) {
      return createTextResponse(request, appPage, HTML_HEADERS);
    }

    if (pathname === APP_SCRIPT_PATH) {
      return createTextResponse(request, browserBundle, JAVASCRIPT_HEADERS);
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

export async function buildClientJavaScript(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("client.tsx", import.meta.url))],
    format: "esm",
    minify: Bun.env.NODE_ENV === "production",
    target: "browser",
  });

  if (!result.success) {
    const details = result.logs.map(({ message }) => message).join("\n");
    throw new Error(`Could not build the browser app:\n${details}`);
  }

  const output = result.outputs[0];

  if (output === undefined) {
    throw new Error("The browser build did not produce JavaScript");
  }

  return output.text();
}
