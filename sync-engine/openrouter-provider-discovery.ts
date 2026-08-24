import {
  isOpenRouterProviderTag,
  type OpenRouterProviderCatalog,
  type OpenRouterProviderOption,
} from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  abortSignalError,
  executeWithAbortSignal,
  readBoundedString,
  readBoundedTrimmedString,
  readFiniteNumber,
  readNonNegativeSafeInteger,
  requireRecord,
} from "../shared/validation.ts";
import { agentProviderRequestHeaders } from "./agent-model.ts";
import { cancelableResponseReader } from "./cancelable-response-reader.ts";
import { createProviderCredentialRejectionError } from "./provider-error.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_CACHE_TTL_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_CACHE_ENTRIES = 256;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_ENDPOINTS = 200;
const MAXIMUM_CONTEXT_WINDOW = 10_000_000;
const MAXIMUM_NAME_LENGTH = 120;
const MODEL_PART_PATTERN = /^[A-Za-z\d][A-Za-z\d._:-]{0,199}$/u;

type OpenRouterProviderDiscoveryFetch = (request: Request) => Promise<Response>;

interface OpenRouterProviderDiscoveryRequestOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export type OpenRouterProviderDiscoverer = (
  ownerId: string,
  credential: ProviderCredentialAccess,
  model: string,
  options?: OpenRouterProviderDiscoveryRequestOptions,
) => Promise<OpenRouterProviderCatalog>;

interface ConfigurableOpenRouterProviderDiscoverer extends OpenRouterProviderDiscoverer {
  withOptions(options: ProviderDiscovererOptions): OpenRouterProviderDiscoverer;
}

interface ProviderDiscovererOptions {
  readonly cacheTtlMilliseconds?: number;
  readonly fetch?: OpenRouterProviderDiscoveryFetch;
  readonly maximumCacheEntries?: number;
  readonly now?: () => number;
  readonly timeoutMilliseconds?: number;
}

interface CacheEntry {
  readonly catalog: OpenRouterProviderCatalog;
  readonly expiresAt: number;
}

function modelPath(model: string): string {
  const parts = model.split("/");
  const author = parts[0];
  const slug = parts[1];
  if (
    parts.length !== 2 ||
    author === undefined ||
    slug === undefined ||
    !MODEL_PART_PATTERN.test(author) ||
    !MODEL_PART_PATTERN.test(slug)
  ) {
    throw new Error("The OpenRouter model identifier is invalid");
  }
  return `${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
}

function contextWindow(value: unknown): number | null {
  const integer = readNonNegativeSafeInteger(value);
  return integer !== undefined &&
    integer > 0 &&
    integer <= MAXIMUM_CONTEXT_WINDOW
    ? integer
    : null;
}

function finitePrice(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    const price = readFiniteNumber(value);
    return price !== undefined && price >= 0 ? price : undefined;
  }
  const stringPrice = readBoundedString(value, { maximumLength: 100 });
  if (stringPrice === undefined) {
    return undefined;
  }
  const parsed = Number(stringPrice);
  return Number.isFinite(parsed) && parsed >= 0 ? stringPrice : undefined;
}

function endpointPricing(value: unknown): OpenRouterProviderOption["pricing"] {
  if (!isRecord(value)) {
    return null;
  }
  const input = finitePrice(value["prompt"]);
  const output = finitePrice(value["completion"]);
  if (input === undefined || output === undefined) {
    return null;
  }
  const cachedInput = finitePrice(value["input_cache_read"]);
  const cacheWriteInput = finitePrice(value["input_cache_write"]);
  return {
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    input,
    output,
  };
}

function providerOption(value: unknown): OpenRouterProviderOption | undefined {
  if (!isRecord(value) || value["status"] !== 0) {
    return undefined;
  }
  const tag = readBoundedTrimmedString(value["tag"], 100);
  const name = readBoundedTrimmedString(
    value["provider_name"],
    MAXIMUM_NAME_LENGTH,
  );
  if (
    tag === undefined ||
    !isOpenRouterProviderTag(tag) ||
    name === undefined
  ) {
    return undefined;
  }
  return {
    contextWindow: contextWindow(value["context_length"]),
    name,
    pricing: endpointPricing(value["pricing"]),
    tag,
  };
}

function parseCatalog(value: unknown): OpenRouterProviderCatalog {
  const data = requireRecord(
    isRecord(value) ? value["data"] : undefined,
    "OpenRouter returned an invalid serving-provider response",
  );
  const endpoints = data["endpoints"];
  if (!Array.isArray(endpoints)) {
    throw new Error("OpenRouter returned an invalid serving-provider response");
  }
  if (endpoints.length > MAXIMUM_ENDPOINTS) {
    throw new Error("OpenRouter returned too many serving providers");
  }
  const options = new Map<string, OpenRouterProviderOption>();
  for (const value of endpoints) {
    const option = providerOption(value);
    if (option !== undefined && !options.has(option.tag)) {
      options.set(option.tag, option);
    }
  }
  return {
    providers: [...options.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.tag.localeCompare(right.tag),
    ),
  };
}

async function responseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const responseReader = cancelableResponseReader(reader);
  const bytes = new Uint8Array(MAXIMUM_RESPONSE_BYTES);
  let length = 0;
  try {
    for (;;) {
      const part = await executeWithAbortSignal(
        signal,
        responseReader.options("The operation was aborted"),
        () => reader.read(),
      );
      if (part.done) {
        return bytes.subarray(0, length);
      }
      if (length + part.value.byteLength > MAXIMUM_RESPONSE_BYTES) {
        await responseReader.cancel();
        throw new Error(
          "The OpenRouter serving-provider response was too large",
        );
      }
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } finally {
    responseReader.release(signal);
  }
}

function declaredResponseIsTooLarge(response: Response): boolean {
  const declaredBytes = Number(response.headers.get("content-length"));
  return (
    Number.isFinite(declaredBytes) && declaredBytes > MAXIMUM_RESPONSE_BYTES
  );
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    const status = response.status;
    const message = `OpenRouter serving-provider discovery failed with status ${String(status)}`;
    if (status === 401 || status === 402 || status === 403 || status === 429) {
      throw createProviderCredentialRejectionError(message, status);
    }
    throw new Error(message);
  }
  if (declaredResponseIsTooLarge(response)) {
    throw new Error("The OpenRouter serving-provider response was too large");
  }
  const body = await responseBody(response, signal);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new Error("OpenRouter returned invalid endpoint JSON", {
      cause: error,
    });
  }
}

interface RequestAbort {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

function requestAbort(
  timeoutMilliseconds: number,
  external: AbortSignal | undefined,
): RequestAbort {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort(
      new DOMException("The operation timed out", "TimeoutError"),
    );
  }, timeoutMilliseconds);
  const externallyAborted = (): void => {
    controller.abort(
      abortSignalError(
        external ?? controller.signal,
        "The operation was aborted",
      ),
    );
  };
  external?.addEventListener("abort", externallyAborted, { once: true });
  if (external?.aborted === true) {
    externallyAborted();
  }
  return {
    dispose: () => {
      globalThis.clearTimeout(timeout);
      external?.removeEventListener("abort", externallyAborted);
    },
    signal: controller.signal,
  };
}

function cacheKey(
  ownerId: string,
  credentialId: string,
  model: string,
): string {
  return JSON.stringify([ownerId, credentialId, model]);
}

function cacheCatalog(
  cache: Map<string, CacheEntry>,
  key: string,
  entry: CacheEntry,
  maximumEntries: number,
  timestamp: number,
): void {
  cache.delete(key);
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= timestamp) {
      cache.delete(cachedKey);
    }
  }
  while (cache.size >= maximumEntries && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
  if (maximumEntries > 0) {
    cache.set(key, entry);
  }
}

function createOpenRouterProviderDiscoverer(
  options: ProviderDiscovererOptions = {},
): ConfigurableOpenRouterProviderDiscoverer {
  const cache = new Map<string, CacheEntry>();
  const cacheTtlMilliseconds =
    options.cacheTtlMilliseconds ?? DEFAULT_CACHE_TTL_MILLISECONDS;
  const fetch = options.fetch ?? ((request) => globalThis.fetch(request));
  const maximumCacheEntries =
    options.maximumCacheEntries ?? DEFAULT_MAXIMUM_CACHE_ENTRIES;
  const now = options.now ?? Date.now;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;

  const discover: ConfigurableOpenRouterProviderDiscoverer = async (
    ownerId,
    credential,
    model,
    requestOptions = {},
  ) => {
    const path = modelPath(model);
    const key = cacheKey(ownerId, credential.id, model);
    const cached = cache.get(key);
    const timestamp = now();
    if (
      requestOptions.force !== true &&
      cached !== undefined &&
      cached.expiresAt > timestamp
    ) {
      return cached.catalog;
    }
    if (cached !== undefined) {
      cache.delete(key);
    }

    const headers = agentProviderRequestHeaders("openrouter", credential, {
      accept: "application/json",
    });
    headers.delete("content-type");
    const abort = requestAbort(timeoutMilliseconds, requestOptions.signal);
    try {
      const request = new Request(
        `${OPENROUTER_MODELS_URL}/${path}/endpoints`,
        {
          headers,
          method: "GET",
          signal: abort.signal,
        },
      );
      const response = await executeWithAbortSignal(
        abort.signal,
        { abortMessage: "The operation was aborted" },
        () => fetch(request),
      );
      const catalog = parseCatalog(await responseJson(response, abort.signal));
      const cachedAt = now();
      cacheCatalog(
        cache,
        key,
        { catalog, expiresAt: cachedAt + cacheTtlMilliseconds },
        maximumCacheEntries,
        cachedAt,
      );
      return catalog;
    } finally {
      abort.dispose();
    }
  };
  discover.withOptions = createOpenRouterProviderDiscoverer;
  return discover;
}

export const discoverOpenRouterProviders: ConfigurableOpenRouterProviderDiscoverer =
  createOpenRouterProviderDiscoverer();
