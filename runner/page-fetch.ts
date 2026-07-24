import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../shared/auth-model.ts";
import {
  chromiumArguments,
  discoverChromiumExecutable,
  type PageFetchDependencies,
} from "./page-fetch-chromium.ts";
import {
  boundedOutput,
  frameFailure,
  MAXIMUM_RESPONSE_BYTES,
  PAGE_CAPTURE_EXPRESSION,
  readCapture,
  responseFromEvent,
  type PageResponse,
} from "./page-fetch-content.ts";
import {
  connectToPage,
  type DevtoolsConnection,
} from "./page-fetch-devtools.ts";
import { removeChromiumProfile, stopChromium } from "./page-fetch-process.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAXIMUM_TIMEOUT_SECONDS = 120;
const MAXIMUM_URL_LENGTH = 8_192;
const MAXIMUM_REDIRECTS = 10;
const DEVTOOLS_READY_TIMEOUT_MILLISECONDS = 5_000;
const SETTLE_MILLISECONDS = 100;
const MAXIMUM_BROWSER_DIAGNOSTIC_BYTES = 4_096;

type ToolArguments = Readonly<Record<string, unknown>>;

interface NavigationState {
  failure: Error | undefined;
  finalRequestIds: Set<string>;
  frameId: string;
  redirectCount: number;
  response: PageResponse | undefined;
  stop: (() => void) | undefined;
  transferredBytes: number;
}

function parsePageUrl(value: string, errorMessage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorMessage);
  }
  if (
    value.length === 0 ||
    value.length > MAXIMUM_URL_LENGTH ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(errorMessage);
  }
  return url;
}

function readPageUrl(arguments_: ToolArguments): URL {
  const value = arguments_["url"];
  if (typeof value !== "string") {
    throw new Error("Tool argument url must be a valid string");
  }
  const url = parsePageUrl(
    value,
    "Tool argument url must be an absolute HTTP or HTTPS URL without credentials or a fragment",
  );
  return url;
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

async function drainStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<void> {
  const reader = stream.getReader();
  let remaining = maximumBytes;
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
    // Chromium can close its pipes while an error is being reported.
  }
}

function devtoolsUrlFromDiagnostic(value: string): string | undefined {
  return /DevTools listening on (ws:\/\/\S+)/u.exec(value)?.[1];
}

async function waitForDevtoolsUrl(
  child: Bun.ReadableSubprocess,
): Promise<string> {
  const reader = child.stderr.getReader();
  let diagnostic = "";
  try {
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const part = await reader.read();
      if (part.done) {
        throw new Error("Chromium stopped before exposing DevTools");
      }
      diagnostic += Buffer.from(part.value).toString("utf8");
      const url = devtoolsUrlFromDiagnostic(diagnostic);
      if (url !== undefined) {
        return url;
      }
    }
    diagnostic = diagnostic.slice(-MAXIMUM_BROWSER_DIAGNOSTIC_BYTES);
  } finally {
    await reader.cancel();
  }

  const detail = diagnostic.trim().slice(-1_000);
  throw new Error(
    detail.length === 0
      ? "Chromium did not expose its DevTools endpoint"
      : `Chromium could not start: ${detail}`,
  );
}

function validFinalUrl(value: string): string {
  const url = parsePageUrl(
    value,
    "The page redirected to a non-HTTP(S), credentialed, fragmented, or oversized URL",
  );
  return url.toString();
}

function documentContentType(contentType: string): boolean {
  return (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType.endsWith("+html")
  );
}

function requestId(params: unknown): string | undefined {
  const value = isRecord(params) ? params["requestId"] : undefined;
  return typeof value === "string" ? value : undefined;
}

function mainDocumentEvent(
  params: unknown,
  state: NavigationState,
): params is Record<string, unknown> {
  return (
    isRecord(params) &&
    params["type"] === "Document" &&
    (state.frameId === "pending"
      ? state.finalRequestIds.size === 0
      : params["frameId"] === state.frameId)
  );
}

function pausedDocumentRequest(params: unknown):
  | {
      readonly requestId: string;
      readonly responseHeaders: readonly unknown[] | undefined;
      readonly responseStatusCode: number | undefined;
      readonly url: string;
    }
  | undefined {
  if (
    !isRecord(params) ||
    !isRecord(params["request"]) ||
    typeof params["requestId"] !== "string" ||
    typeof params["request"]["url"] !== "string" ||
    (params["resourceType"] !== "Document" &&
      typeof params["networkId"] !== "string")
  ) {
    return undefined;
  }
  return {
    requestId: params["requestId"],
    responseHeaders: Array.isArray(params["responseHeaders"])
      ? params["responseHeaders"]
      : undefined,
    responseStatusCode:
      typeof params["responseStatusCode"] === "number"
        ? params["responseStatusCode"]
        : undefined,
    url: params["request"]["url"],
  };
}

function transferredData(
  params: unknown,
): { readonly bytes: number; readonly requestId: string } | undefined {
  if (!isRecord(params) || typeof params["requestId"] !== "string") {
    return undefined;
  }
  const candidates = [params["encodedDataLength"], params["dataLength"]].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  const bytes = candidates.length === 0 ? undefined : Math.max(...candidates);
  return bytes === undefined
    ? undefined
    : { bytes, requestId: params["requestId"] };
}

function responseSizeError(): Error {
  return new Error(
    `Page response exceeds the ${String(MAXIMUM_RESPONSE_BYTES)} byte limit`,
  );
}

function headerValue(headers: readonly unknown[], name: string): unknown {
  const header = headers.find(
    (value) =>
      isRecord(value) &&
      typeof value["name"] === "string" &&
      value["name"].toLowerCase() === name,
  );
  return isRecord(header) ? header["value"] : undefined;
}

function contentLength(headers: readonly unknown[]): number | undefined {
  const length = Number(headerValue(headers, "content-length"));
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function responseLocation(headers: readonly unknown[]): string | undefined {
  const location = headerValue(headers, "location");
  return typeof location === "string" ? location : undefined;
}

function invalidRequestUrl(url: string, base?: string): boolean {
  try {
    validFinalUrl(base === undefined ? url : new URL(url, base).toString());
    return false;
  } catch {
    return true;
  }
}

async function rejectRequest(
  connection: DevtoolsConnection,
  requestId: string,
  state: NavigationState,
  error: Error,
): Promise<void> {
  state.failure = error;
  await connection.command("Fetch.failRequest", {
    errorReason: "BlockedByClient",
    requestId,
  });
}

async function rejectRedirect(
  connection: DevtoolsConnection,
  requestId: string,
  state: NavigationState,
): Promise<void> {
  await rejectRequest(
    connection,
    requestId,
    state,
    new Error(
      "The page redirected to a non-HTTP(S), credentialed, fragmented, or oversized URL",
    ),
  );
}

async function continueOrRejectRequest(
  connection: DevtoolsConnection,
  params: unknown,
  state: NavigationState,
): Promise<void> {
  const request = pausedDocumentRequest(params);
  if (request === undefined) {
    return;
  }
  if (
    request.responseStatusCode !== undefined &&
    request.responseStatusCode >= 200 &&
    request.responseStatusCode < 300 &&
    request.responseHeaders !== undefined &&
    (contentLength(request.responseHeaders) ?? 0) > MAXIMUM_RESPONSE_BYTES
  ) {
    await rejectRequest(
      connection,
      request.requestId,
      state,
      responseSizeError(),
    );
    return;
  }
  if (
    request.responseStatusCode !== undefined &&
    request.responseStatusCode >= 300 &&
    request.responseStatusCode < 400
  ) {
    state.redirectCount += 1;
    if (state.redirectCount > MAXIMUM_REDIRECTS) {
      await rejectRequest(
        connection,
        request.requestId,
        state,
        new Error(
          `Page navigation exceeded the ${String(MAXIMUM_REDIRECTS)} redirect limit`,
        ),
      );
      return;
    }
    const location =
      request.responseHeaders === undefined
        ? undefined
        : responseLocation(request.responseHeaders);
    if (location !== undefined && invalidRequestUrl(location, request.url)) {
      await rejectRedirect(connection, request.requestId, state);
      return;
    }
  }
  const requestUrlInvalid = invalidRequestUrl(request.url);
  if (requestUrlInvalid) {
    return rejectRedirect(connection, request.requestId, state);
  }
  await connection.command("Fetch.continueRequest", {
    requestId: request.requestId,
  });
}

async function followPageEvents(
  connection: DevtoolsConnection,
  events: ReturnType<DevtoolsConnection["subscribe"]>,
  state: NavigationState,
): Promise<void> {
  for (;;) {
    const event = await events.next();
    if (event === undefined) {
      throw new Error("Chromium closed before the page was ready");
    }
    if (event.method === "Page.loadEventFired") {
      return;
    }
    if (event.method === "Fetch.requestPaused") {
      await continueOrRejectRequest(connection, event.params, state);
    } else if (event.method === "Network.requestWillBeSent") {
      if (mainDocumentEvent(event.params, state)) {
        if (
          isRecord(event.params["redirectResponse"]) &&
          state.redirectCount === 0
        ) {
          state.redirectCount += 1;
        }
        const id = requestId(event.params);
        if (id !== undefined) {
          state.finalRequestIds.add(id);
          if (isRecord(event.params["redirectResponse"])) {
            state.transferredBytes = 0;
          }
        }
      }
    } else if (event.method === "Network.responseReceived") {
      if (
        mainDocumentEvent(event.params, state) ||
        (isRecord(event.params) &&
          typeof event.params["requestId"] === "string" &&
          state.finalRequestIds.has(event.params["requestId"]))
      ) {
        const candidate = responseFromEvent(event.params);
        if (candidate !== undefined) {
          state.response = candidate;
          state.finalRequestIds.add(candidate.requestId);
          if (candidate.contentLength !== undefined) {
            state.transferredBytes = Math.max(
              state.transferredBytes,
              candidate.contentLength,
            );
          }
          if (
            (candidate.contentLength !== undefined &&
              candidate.contentLength > MAXIMUM_RESPONSE_BYTES) ||
            state.transferredBytes > MAXIMUM_RESPONSE_BYTES
          ) {
            state.failure = responseSizeError();
          }
        }
      }
    } else if (event.method === "Network.dataReceived") {
      const data = transferredData(event.params);
      if (
        data !== undefined &&
        state.finalRequestIds.has(data.requestId) &&
        state.failure === undefined
      ) {
        state.transferredBytes += data.bytes;
        if (state.transferredBytes > MAXIMUM_RESPONSE_BYTES) {
          state.failure = responseSizeError();
          state.stop?.();
        }
      }
    } else if (event.method === "Network.loadingFailed") {
      const failure = frameFailure(event.params, state.frameId);
      if (
        failure !== undefined &&
        state.frameId !== "pending" &&
        state.failure === undefined
      ) {
        state.failure = new Error(
          failure === "net::ERR_ABORTED"
            ? "Page navigation did not return HTML"
            : `Page navigation failed: ${failure}`,
        );
      }
    }
    if (state.failure !== undefined) {
      events.close();
      throw state.failure;
    }
  }
}

async function renderPage(
  connection: DevtoolsConnection,
  url: URL,
  state: NavigationState,
): Promise<string> {
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
        { requestStage: "Request", resourceType: "Document" },
        { requestStage: "Response", resourceType: "Document" },
      ],
    }),
  ]);
  await connection.command("Network.clearBrowserCache");
  await connection.command("Network.clearBrowserCookies");

  const events = connection.subscribe([
    "Fetch.requestPaused",
    "Network.dataReceived",
    "Network.loadingFailed",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Page.loadEventFired",
  ]);
  try {
    const loading = followPageEvents(connection, events, state);
    void loading.catch(() => undefined);
    const navigation = await connection.command("Page.navigate", {
      url: url.toString(),
    });
    if (!isRecord(navigation) || typeof navigation["frameId"] !== "string") {
      throw new Error("Chromium did not start the page navigation");
    }
    state.frameId = navigation["frameId"];
    if (typeof navigation["errorText"] === "string") {
      if (
        navigation["errorText"] === "net::ERR_BLOCKED_BY_CLIENT" &&
        state.failure !== undefined
      ) {
        throw state.failure;
      }
      throw new Error(
        navigation["errorText"] === "net::ERR_ABORTED"
          ? "Page navigation did not return HTML"
          : `Page navigation failed: ${navigation["errorText"]}`,
      );
    }
    await loading;
  } finally {
    events.close();
  }

  if (state.failure !== undefined) {
    throw state.failure;
  }
  if (state.response === undefined) {
    throw new Error("Page navigation completed without an HTTP response");
  }
  const finalResponse = {
    ...state.response,
    finalUrl: validFinalUrl(state.response.finalUrl),
  };
  if (!documentContentType(finalResponse.contentType)) {
    throw new Error(
      `Page navigation did not return HTML (received ${finalResponse.contentType || "an unknown content type"})`,
    );
  }
  if (
    finalResponse.contentLength !== undefined &&
    finalResponse.contentLength > MAXIMUM_RESPONSE_BYTES
  ) {
    throw responseSizeError();
  }

  await Bun.sleep(SETTLE_MILLISECONDS);
  const evaluated = await connection.command("Runtime.evaluate", {
    awaitPromise: true,
    expression: PAGE_CAPTURE_EXPRESSION,
    returnByValue: true,
  });
  return boundedOutput(finalResponse, readCapture(evaluated));
}

function terminationError(reason: "stopped" | "timed-out"): Error {
  return new Error(
    reason === "stopped"
      ? "The page fetch was stopped"
      : "The page fetch timed out",
  );
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function monitoredRender(
  render: () => Promise<string>,
  stopProcess: () => void,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const state = { settled: false };
    const settle = (): void => {
      state.settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    const resolveOnce = (output: string): void => {
      if (state.settled) {
        return;
      }
      settle();
      resolve(output);
    };
    const rejectOnce = (error: Error): void => {
      if (state.settled) {
        return;
      }
      settle();
      reject(error);
    };
    const stop = (): void => {
      stopProcess();
      rejectOnce(terminationError("stopped"));
    };
    const timer = setTimeout(() => {
      stopProcess();
      rejectOnce(terminationError("timed-out"));
    }, timeoutMilliseconds);
    signal?.addEventListener("abort", stop, { once: true });
    void render().then(resolveOnce, (error: unknown) => {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    });
    if (signal?.aborted === true) {
      queueMicrotask(stop);
    }
  });
}

export async function fetchRenderedPage(
  arguments_: ToolArguments,
  signal?: AbortSignal,
  dependencies: PageFetchDependencies = {},
): Promise<string> {
  const url = readPageUrl(arguments_);
  const timeoutMilliseconds = readTimeoutMilliseconds(arguments_);
  const deadline = Date.now() + timeoutMilliseconds;
  const executablePath = await discoverChromiumExecutable(dependencies);
  const profilePath = await mkdtemp(join(tmpdir(), "q-mush-page-fetch-"));
  const child = Bun.spawn([...chromiumArguments(executablePath, profilePath)], {
    env: {
      ...process.env,
      HOME: profilePath,
      XDG_CACHE_HOME: join(profilePath, "cache"),
      XDG_CONFIG_HOME: join(profilePath, "config"),
      XDG_DATA_HOME: join(profilePath, "data"),
      XDG_STATE_HOME: join(profilePath, "state"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  let connection: DevtoolsConnection | undefined;
  let stopping: Promise<void> | undefined;
  const stopProcess = (): void => {
    stopping ??= stopChromium(child, profilePath);
    void stopping.catch(() => undefined);
  };

  try {
    const devtoolsUrl = await monitoredRender(
      () => waitForDevtoolsUrl(child),
      stopProcess,
      Math.min(
        remainingMilliseconds(deadline),
        DEVTOOLS_READY_TIMEOUT_MILLISECONDS,
      ),
      signal,
    );
    const pageConnection = await connectToPage(devtoolsUrl);
    connection = pageConnection;
    const navigationState: NavigationState = {
      failure: undefined,
      finalRequestIds: new Set(),
      frameId: "pending",
      redirectCount: 0,
      response: undefined,
      stop: stopProcess,
      transferredBytes: 0,
    };
    return await monitoredRender(
      () => renderPage(pageConnection, url, navigationState),
      stopProcess,
      remainingMilliseconds(deadline),
      signal,
    );
  } finally {
    connection?.close();
    stopProcess();
    try {
      await stopping;
    } finally {
      await drainStream(child.stdout, MAXIMUM_BROWSER_DIAGNOSTIC_BYTES);
      await removeChromiumProfile(profilePath);
    }
  }
}
