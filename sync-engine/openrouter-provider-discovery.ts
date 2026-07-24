import {
  isOpenRouterProviderTag,
  type OpenRouterProviderCatalog,
  type OpenRouterProviderOption,
} from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import { boundedPositiveInteger } from "../shared/numbers.ts";
import { abortSignalError, errorFromUnknown } from "../shared/parallel.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import { agentProviderRequestHeaders } from "./agent-model.ts";

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

function boundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : undefined;
}

function contextWindow(value: unknown): number | null {
  return boundedPositiveInteger(value, MAXIMUM_CONTEXT_WINDOW);
}

function finitePrice(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? value : undefined;
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
  const tag = boundedString(value["tag"], 100);
  const name = boundedString(value["provider_name"], MAXIMUM_NAME_LENGTH);
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
  if (!isRecord(value) || !isRecord(value["data"])) {
    throw new Error("OpenRouter returned an invalid serving-provider response");
  }
  const endpoints = value["data"]["endpoints"];
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

async function abortableOperation<Value>(
  signal: AbortSignal,
  operation: () => Promise<Value>,
): Promise<Value> {
  if (signal.aborted) {
    throw abortSignalError(signal, "The operation was aborted");
  }
  return await new Promise<Value>((resolve, reject) => {
    const aborted = (): void => {
      reject(abortSignalError(signal, "The operation was aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      operation()
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    } catch (error) {
      signal.removeEventListener("abort", aborted);
      reject(errorFromUnknown(error));
    }
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

async function responseBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let byteLength = 0;

  for (;;) {
    const part = await abortableOperation(signal, () => reader.read());
    if (part.done) {
      return body + decoder.decode();
    }
    byteLength += part.value.byteLength;
    if (byteLength > MAXIMUM_RESPONSE_BYTES) {
      cancelReader(reader);
      throw new Error("The OpenRouter serving-provider response was too large");
    }
    body += decoder.decode(part.value, { stream: true });
  }
}

function declaredResponseIsTooLarge(
  response: Response,
  maximumBytes: number,
): boolean {
  const header = response.headers.get("content-length");
  if (header === null) {
    return false;
  }
  const declaredBytes = Number(header);
  return Number.isFinite(declaredBytes) && declaredBytes > maximumBytes;
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `OpenRouter serving-provider discovery failed with status ${String(response.status)}`,
    );
  }
  if (declaredResponseIsTooLarge(response, MAXIMUM_RESPONSE_BYTES)) {
    throw new Error("The OpenRouter serving-provider response was too large");
  }
  const body = await responseBody(response, signal);
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch (error) {
    throw new Error("OpenRouter returned invalid endpoint JSON", {
      cause: error,
    });
  }
}

function combinedSignal(
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function abortableFetch(
  fetch: OpenRouterProviderDiscoveryFetch,
  request: Request,
): Promise<Response> {
  return await abortableOperation(request.signal, () => fetch(request));
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

    const headers = agentProviderRequestHeaders(
      "openrouter",
      credential,
      "application/json",
    );
    headers.delete("content-type");
    const request = new Request(`${OPENROUTER_MODELS_URL}/${path}/endpoints`, {
      headers,
      method: "GET",
      signal: combinedSignal(timeoutMilliseconds, requestOptions.signal),
    });
    const response = await abortableFetch(fetch, request);
    const catalog = parseCatalog(await responseJson(response, request.signal));
    const cachedAt = now();
    cacheCatalog(
      cache,
      key,
      {
        catalog,
        expiresAt: cachedAt + cacheTtlMilliseconds,
      },
      maximumCacheEntries,
      cachedAt,
    );
    return catalog;
  };
  discover.withOptions = createOpenRouterProviderDiscoverer;
  return discover;
}

export const discoverOpenRouterProviders: ConfigurableOpenRouterProviderDiscoverer =
  createOpenRouterProviderDiscoverer();
