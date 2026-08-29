import { chown, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../shared/auth-model.ts";
import { PAGE_FETCH_TOOL_NAME } from "../shared/page-fetch.ts";
import { runBoundedPageOperation } from "./page-fetch-bounded.ts";
import {
  assertChromiumExecutableAccessible,
  chromiumArguments,
  chromiumChildIdentity,
  discoverChromiumExecutable,
  type ChromiumDiscoveryOptions,
} from "./page-fetch-chromium.ts";
import {
  MAXIMUM_RESPONSE_BYTES,
  outputRecord,
  PAGE_CAPTURE_EXPRESSION,
  readCapture,
  type PageResponse,
} from "./page-fetch-content.ts";
import {
  connectToPage,
  type DevtoolsConnection,
  type DevtoolsEvent,
} from "./page-fetch-devtools.ts";
import {
  assertPublicPageUrl,
  createPageFetchProxy,
  defaultPageAddressResolver,
  removeChromiumProfile,
  stopChromium,
  type PageAddressResolver,
} from "./page-fetch-process.ts";
import {
  retryChromiumStartup,
  runWithCleanup,
  waitForChromiumDevtoolsUrl,
} from "./page-fetch-startup.ts";
import { parseRunnerUrl } from "./runner-url.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAXIMUM_TIMEOUT_SECONDS = 120;
const MAXIMUM_URL_LENGTH = 8_192;
const MAXIMUM_REDIRECTS = 10;
const MAXIMUM_BROWSER_DIAGNOSTIC_BYTES = 4_096;
const SETTLE_MILLISECONDS = 100;
// Root's TMPDIR may not be traversable by nobody; /tmp is the shared system location.
const ROOT_CHROMIUM_TEMPORARY_DIRECTORY = "/tmp";

type ToolArguments = Readonly<Record<string, unknown>>;
type PageCapture = Pick<PageRenderRequest, "captureExpression" | "url">;

interface PageNavigationPolicy {
  bytes(byteLength: number): void;
  document(url: string): Promise<void>;
  redirect(location: string, sourceUrl: string): Promise<void>;
  request(url: string): Promise<void>;
  response(response: PageResponse): void;
}

interface PageRenderRequest {
  readonly captureExpression: string;
  readonly policy: PageNavigationPolicy;
  readonly signal: AbortSignal;
  readonly url: URL;
}

interface PageRenderResult {
  readonly evaluated: unknown;
  readonly response: PageResponse;
}

type PageRenderer = (request: PageRenderRequest) => Promise<PageRenderResult>;

export interface PageFetchDependencies extends ChromiumDiscoveryOptions {
  readonly render?:
    ((request: PageRenderRequest) => Promise<PageRenderResult>) | undefined;
  readonly resolveAddress?: PageAddressResolver | undefined;
}

export type PageFetchRunnerTool = (
  root: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
) => Promise<string>;

export { PAGE_FETCH_TOOL_NAME };

function parsePageUrl(value: string, message: string): URL {
  const url = parseRunnerUrl(value, message);
  if (
    value.length === 0 ||
    value.length > MAXIMUM_URL_LENGTH ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new Error(message);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Page URL must not contain credentials");
  }
  if (url.hash.length > 0) {
    throw new Error("Page URL must not contain a fragment");
  }
  return url;
}

function readPageUrl(arguments_: ToolArguments): URL {
  const value = arguments_["url"];
  if (typeof value !== "string") {
    throw new Error("Tool argument url must be a valid string");
  }
  return parsePageUrl(
    value,
    "Tool argument url must be an absolute HTTP or HTTPS URL",
  );
}

function readTimeoutMilliseconds(arguments_: ToolArguments): number {
  const value = arguments_["timeout"];
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS * 1_000;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `Tool argument timeout must be an integer from 1 to ${String(MAXIMUM_TIMEOUT_SECONDS)}`,
    );
  }
  return value * 1_000;
}

function htmlContentType(value: string): boolean {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType.endsWith("+html")
  );
}

function responseSizeError(): Error {
  return new Error(
    `Page response exceeds the ${String(MAXIMUM_RESPONSE_BYTES)} byte limit`,
  );
}

function createNavigationPolicy(
  resolveAddress: PageAddressResolver,
): PageNavigationPolicy {
  let documentCount = 0;
  let transferredBytes = 0;
  return {
    bytes: (byteLength) => {
      if (!Number.isFinite(byteLength) || byteLength < 0) {
        throw new Error("Chromium reported an invalid page response size");
      }
      transferredBytes += byteLength;
      if (transferredBytes > MAXIMUM_RESPONSE_BYTES) {
        throw responseSizeError();
      }
    },
    document: async (value) => {
      const url = parsePageUrl(
        value,
        "The page redirected to a non-HTTP(S) or oversized URL",
      );
      documentCount += 1;
      if (documentCount - 1 > MAXIMUM_REDIRECTS) {
        throw new Error(
          `Page navigation exceeded the ${String(MAXIMUM_REDIRECTS)} redirect limit`,
        );
      }
      await assertPublicPageUrl(url, resolveAddress);
    },
    redirect: async (location, sourceUrl) => {
      let target: string;
      try {
        target = new URL(location, sourceUrl).toString();
      } catch {
        throw new Error("The page redirected to an invalid URL");
      }
      const url = parsePageUrl(
        target,
        "The page redirected to a non-HTTP(S) or oversized URL",
      );
      await assertPublicPageUrl(url, resolveAddress);
    },
    request: async (value) => {
      const url = parsePageUrl(
        value,
        "The page requested a non-HTTP(S) or oversized URL",
      );
      await assertPublicPageUrl(url, resolveAddress);
    },
    response: (response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Page navigation returned HTTP ${String(response.status)}`,
        );
      }
      if (!htmlContentType(response.contentType)) {
        throw new Error(
          `Page navigation did not return HTML (received ${response.contentType || "an unknown content type"})`,
        );
      }
      if (
        response.contentLength !== undefined &&
        response.contentLength > MAXIMUM_RESPONSE_BYTES
      ) {
        throw responseSizeError();
      }
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The page fetch was stopped");
}

function responseFromEvent(params: unknown): PageResponse | undefined {
  if (!isRecord(params) || !isRecord(params["response"])) {
    return undefined;
  }
  const response = params["response"];
  if (
    typeof response["url"] !== "string" ||
    typeof response["mimeType"] !== "string" ||
    typeof response["status"] !== "number" ||
    !Number.isSafeInteger(response["status"])
  ) {
    return undefined;
  }
  const headers = isRecord(response["headers"]) ? response["headers"] : {};
  const parsedLength = Number(
    headers["content-length"] ?? headers["Content-Length"],
  );
  return {
    charset:
      typeof response["charset"] === "string"
        ? response["charset"].toLowerCase()
        : "",
    contentLength:
      Number.isSafeInteger(parsedLength) && parsedLength >= 0
        ? parsedLength
        : undefined,
    contentType: response["mimeType"].toLowerCase(),
    finalUrl: response["url"],
    status: response["status"],
  };
}

function requestEvent(params: unknown):
  | {
      readonly document: boolean;
      readonly requestId: string;
      readonly responseHeaders: readonly unknown[] | undefined;
      readonly responseStatusCode: number | undefined;
      readonly url: string;
    }
  | undefined {
  return isRecord(params) &&
    isRecord(params["request"]) &&
    typeof params["requestId"] === "string" &&
    typeof params["request"]["url"] === "string"
    ? {
        document: params["resourceType"] === "Document",
        requestId: params["requestId"],
        responseHeaders: Array.isArray(params["responseHeaders"])
          ? params["responseHeaders"]
          : undefined,
        responseStatusCode:
          typeof params["responseStatusCode"] === "number"
            ? params["responseStatusCode"]
            : undefined,
        url: params["request"]["url"],
      }
    : undefined;
}

function headerValue(
  headers: readonly unknown[],
  name: string,
): string | undefined {
  for (const header of headers) {
    if (
      isRecord(header) &&
      typeof header["name"] === "string" &&
      header["name"].toLowerCase() === name &&
      typeof header["value"] === "string"
    ) {
      return header["value"];
    }
  }
  return undefined;
}

async function continuePausedRequest(
  connection: DevtoolsConnection,
  request: PageRenderRequest,
  paused: NonNullable<ReturnType<typeof requestEvent>>,
): Promise<void> {
  try {
    if (paused.responseStatusCode === undefined) {
      if (paused.document) {
        await request.policy.document(paused.url);
      } else {
        await request.policy.request(paused.url);
      }
    } else if (
      paused.document &&
      paused.responseStatusCode >= 300 &&
      paused.responseStatusCode < 400 &&
      paused.responseHeaders !== undefined
    ) {
      const location = headerValue(paused.responseHeaders, "location");
      if (location !== undefined) {
        await request.policy.redirect(location, paused.url);
      }
    }
    await connection.command("Fetch.continueRequest", {
      requestId: paused.requestId,
    });
  } catch (error) {
    await connection
      .command("Fetch.failRequest", {
        errorReason: "BlockedByClient",
        requestId: paused.requestId,
      })
      .catch(() => undefined);
    throw error;
  }
}

async function followPageEvents(
  connection: DevtoolsConnection,
  request: PageRenderRequest,
): Promise<PageResponse> {
  const events = connection.subscribe([
    "Fetch.requestPaused",
    "Network.dataReceived",
    "Network.responseReceived",
    "Page.loadEventFired",
  ]);
  let finalResponse: PageResponse | undefined;
  try {
    for (;;) {
      if (request.signal.aborted) {
        throw abortError(request.signal);
      }
      const event: DevtoolsEvent | undefined = await events.next();
      if (event === undefined) {
        throw new Error("Chromium closed before the page was ready");
      }
      if (event.method === "Page.loadEventFired") {
        if (finalResponse === undefined) {
          throw new Error("Page navigation completed without an HTTP response");
        }
        return finalResponse;
      }
      if (event.method === "Fetch.requestPaused") {
        const paused = requestEvent(event.params);
        if (paused !== undefined) {
          await continuePausedRequest(connection, request, paused);
        }
      } else if (event.method === "Network.responseReceived") {
        if (isRecord(event.params) && isRecord(event.params["response"])) {
          if (event.params["type"] === "Document") {
            const response = responseFromEvent(event.params);
            if (response !== undefined) {
              if (response.status < 300 || response.status >= 400) {
                request.policy.response(response);
                finalResponse = response;
              }
            }
          }
        }
      } else if (
        event.method === "Network.dataReceived" &&
        isRecord(event.params) &&
        typeof event.params["dataLength"] === "number"
      ) {
        request.policy.bytes(event.params["dataLength"]);
      }
    }
  } finally {
    events.close();
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let remaining = MAXIMUM_BROWSER_DIAGNOSTIC_BYTES;
  try {
    while (remaining > 0) {
      const part = await reader.read();
      if (part.done) {
        return;
      }
      remaining -= part.value.byteLength;
    }
    await reader.cancel();
  } catch {
    // Chromium can close its pipes during cleanup.
  }
}

type ChromiumProfileDependencies = Readonly<{
  chownPath?:
    ((path: string, uid: number, gid: number) => Promise<void>) | undefined;
  createTemporaryDirectory?: ((prefix: string) => Promise<string>) | undefined;
  removeProfile?: ((path: string) => Promise<void>) | undefined;
}>;

export async function createChromiumProfile(
  identity: Awaited<ReturnType<typeof chromiumChildIdentity>>,
  dependencies: ChromiumProfileDependencies = {},
): Promise<string> {
  const createTemporaryDirectory =
    dependencies.createTemporaryDirectory ?? mkdtemp;
  const profilePath = await createTemporaryDirectory(
    join(
      identity === undefined ? tmpdir() : ROOT_CHROMIUM_TEMPORARY_DIRECTORY,
      "q-mush-page-fetch-",
    ),
  );
  if (identity === undefined) {
    return profilePath;
  }
  try {
    await (dependencies.chownPath ?? chown)(
      profilePath,
      identity.uid,
      identity.gid,
    );
    return profilePath;
  } catch (error) {
    await (dependencies.removeProfile ?? removeChromiumProfile)(profilePath);
    throw new Error(
      "Could not prepare an unprivileged Chromium profile for the root Q Mush runner",
      { cause: error },
    );
  }
}

type ChromiumSpawn = (
  command: string[],
  options: Parameters<typeof Bun.spawn>[1],
) => Bun.ReadableSubprocess;

export function spawnChromium(
  executablePath: string,
  profilePath: string,
  proxyPort: number,
  identity: Awaited<ReturnType<typeof chromiumChildIdentity>>,
  spawn: ChromiumSpawn = Bun.spawn,
): Bun.ReadableSubprocess {
  return spawn([...chromiumArguments(executablePath, profilePath, proxyPort)], {
    cwd: profilePath,
    detached: process.platform !== "win32",
    env: {
      HOME: profilePath,
      LANG: process.env["LANG"] ?? "C.UTF-8",
      PATH: process.env["PATH"] ?? "",
      TMPDIR: profilePath,
      XDG_CACHE_HOME: join(profilePath, "cache"),
      XDG_CONFIG_HOME: join(profilePath, "config"),
      XDG_DATA_HOME: join(profilePath, "data"),
      XDG_STATE_HOME: join(profilePath, "state"),
    },
    ...(identity ?? {}),
    stderr: "pipe",
    stdout: "pipe",
  });
}

function defaultRenderer(
  options: PageFetchDependencies,
  resolveAddress: PageAddressResolver,
): PageRenderer {
  return (request) =>
    retryChromiumStartup(async () => {
      const executablePath = await discoverChromiumExecutable(options);
      const identity = await chromiumChildIdentity();
      await assertChromiumExecutableAccessible(executablePath, identity);
      const profilePath = await createChromiumProfile(identity);
      const proxy = createPageFetchProxy(resolveAddress);
      let child: Bun.ReadableSubprocess;
      try {
        const proxyPort = await proxy.start();
        child = spawnChromium(executablePath, profilePath, proxyPort, identity);
      } catch (error) {
        try {
          await proxy.close();
        } finally {
          await removeChromiumProfile(profilePath);
        }
        throw error;
      }
      const browser = child;
      let connection: DevtoolsConnection | undefined;
      let stopping: Promise<void> | undefined;
      const stoppingPromise = (): Promise<void> => {
        stopping ??= stopChromium(browser, profilePath);
        return stopping;
      };
      const stop = (): void => {
        void stoppingPromise().catch(() => undefined);
      };
      request.signal.addEventListener("abort", stop, { once: true });
      return await runWithCleanup(
        async () => {
          const devtoolsUrl = await waitForChromiumDevtoolsUrl(
            browser,
            request.signal,
          );
          connection = await connectToPage(devtoolsUrl);
          await connection.open();
          await Promise.all([
            connection.command("Page.enable"),
            connection.command("Network.enable", {
              maxResourceBufferSize: MAXIMUM_RESPONSE_BYTES,
              maxTotalBufferSize: MAXIMUM_RESPONSE_BYTES,
            }),
            connection.command("Runtime.enable"),
            connection.command("Fetch.enable", {
              patterns: [
                { requestStage: "Request" },
                { requestStage: "Response", resourceType: "Document" },
              ],
            }),
          ]);
          await connection.command("Network.clearBrowserCache");
          await connection.command("Network.clearBrowserCookies");
          const loading = followPageEvents(connection, request);
          void loading.catch(() => undefined);
          const navigation = await connection.command("Page.navigate", {
            url: request.url.toString(),
          });
          if (
            !isRecord(navigation) ||
            typeof navigation["frameId"] !== "string"
          ) {
            throw new Error("Chromium did not start the page navigation");
          }
          if (typeof navigation["errorText"] === "string") {
            throw new Error(
              `Page navigation failed: ${navigation["errorText"]}`,
            );
          }
          const response = await loading;
          if (proxy.failure !== undefined) {
            throw proxy.failure;
          }
          await Bun.sleep(SETTLE_MILLISECONDS);
          const evaluated = await connection.command("Runtime.evaluate", {
            awaitPromise: true,
            expression: request.captureExpression,
            returnByValue: true,
          });
          return { evaluated, response };
        },
        async () => {
          request.signal.removeEventListener("abort", stop);
          connection?.close();
          stop();
          try {
            await stoppingPromise();
          } finally {
            try {
              await proxy.close();
            } finally {
              try {
                await drainStream(browser.stdout);
              } finally {
                await removeChromiumProfile(profilePath);
              }
            }
          }
        },
      );
    }, request.signal);
}

function createPageCapture(arguments_: ToolArguments): PageCapture {
  return {
    captureExpression: PAGE_CAPTURE_EXPRESSION,
    url: readPageUrl(arguments_),
  };
}

/** @public Low-level page fetch entry retained for deterministic integration tests. */
export async function fetchRenderedPage(
  arguments_: ToolArguments,
  signal?: AbortSignal,
  dependencies: PageFetchDependencies = {},
): Promise<string> {
  const capture = createPageCapture(arguments_);
  const timeoutMilliseconds = readTimeoutMilliseconds(arguments_);
  const resolveAddress =
    dependencies.resolveAddress ?? defaultPageAddressResolver;
  const policy = createNavigationPolicy(resolveAddress);
  const render =
    dependencies.render ?? defaultRenderer(dependencies, resolveAddress);
  return runBoundedPageOperation(
    async (boundedSignal) => {
      await assertPublicPageUrl(capture.url, resolveAddress);
      const result = await render({
        ...capture,
        policy,
        signal: boundedSignal,
      });
      const finalUrl = parsePageUrl(
        result.response.finalUrl,
        "The page redirected to a non-HTTP(S) or oversized URL",
      );
      await assertPublicPageUrl(finalUrl, resolveAddress);
      policy.response(result.response);
      return JSON.stringify(
        outputRecord(result.response, readCapture(result.evaluated)),
        undefined,
        2,
      );
    },
    timeoutMilliseconds,
    signal,
  );
}

export function createPageFetchRunnerTool(
  dependencies: PageFetchDependencies = {},
): PageFetchRunnerTool {
  return (root, arguments_, signal) => {
    void root;
    return fetchRenderedPage(arguments_, signal, dependencies);
  };
}
