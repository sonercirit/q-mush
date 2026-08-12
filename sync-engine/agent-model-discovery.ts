import {
  AGENT_REASONING_EFFORTS,
  MAXIMUM_AGENT_MODEL_OPTIONS,
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { isRecord, readRequiredArray } from "../shared/auth-model.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import { utf8Prefix } from "../shared/utf8.ts";
import { readPositiveSafeInteger } from "../shared/validation.ts";
import { withAnthropicCapabilities } from "./agent-model-discovery-anthropic.ts";
import {
  agentProviderRequestHeaders,
  type AgentProviderCredential,
} from "./agent-model.ts";
import { genericProviderEndpoint } from "./generic-provider-url.ts";
import { isProviderCredentialRejection } from "./provider-error.ts";

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const MODEL_CLIENT_VERSION = "1.0.0";
const MAXIMUM_RESPONSE_LENGTH = 5 * 1024 * 1024;
const MAXIMUM_MODEL_LABEL_BYTES = 300;
const MAXIMUM_MODEL_FALLBACK_PROMPT_BYTES = 4_000;
const MAXIMUM_MODEL_METADATA_ITEMS = 20;
const MAXIMUM_MODEL_METADATA_INPUT_ITEMS = 100;
const MAXIMUM_MODEL_METADATA_TEXT_BYTES = 100;
const MODEL_CATALOG_TOO_LARGE = "The provider model catalog was too large";
const MODEL_CATALOG_HAS_TOO_MANY_OPTIONS =
  "The provider model catalog has too many options";
const INCOMPATIBLE_OPENAI_MODEL_MARKERS = [
  "audio",
  "computer-use",
  "embedding",
  "image",
  "instruct",
  "moderation",
  "realtime",
  "search",
  "transcribe",
  "tts",
  "whisper",
] as const;

export type AgentModelDiscoveryFetch = (request: Request) => Promise<Response>;

export type AgentModelDiscoverer = (
  provider: ProviderId,
  credential: ProviderCredentialAccess,
) => Promise<AgentModelCatalog>;

interface PrioritizedModel {
  readonly model: AgentModelOption;
  readonly priority: number;
}

export class AgentModelDiscoveryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AgentModelDiscoveryError";
    this.status = status;
  }
}

export function isCredentialRejectionError(error: unknown): boolean {
  return (
    isProviderCredentialRejection(error) ||
    (error instanceof AgentModelDiscoveryError &&
      (error.status === 401 ||
        error.status === 402 ||
        error.status === 403 ||
        error.status === 429))
  );
}

function modelDiscoveryError(
  message: string,
  status?: number,
): AgentModelDiscoveryError {
  return new AgentModelDiscoveryError(message, status);
}

export function safeAgentModelDiscoveryError(error: unknown): string {
  return error instanceof AgentModelDiscoveryError
    ? error.message
    : "Model discovery failed because the provider is unavailable";
}

function modelLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? utf8Prefix(value.trim(), MAXIMUM_MODEL_LABEL_BYTES)
    : fallback;
}

function boundedArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, MAXIMUM_MODEL_METADATA_INPUT_ITEMS)
    : undefined;
}

function reasoningEfforts(value: unknown): readonly AgentReasoningEffort[] {
  const candidates = boundedArray(value);
  if (candidates === undefined) {
    return [];
  }

  const efforts: AgentReasoningEffort[] = [];

  for (const item of candidates) {
    const effort = isRecord(item) ? item["effort"] : item;

    if (isAgentReasoningEffort(effort) && !efforts.includes(effort)) {
      efforts.push(effort);
      if (efforts.length === AGENT_REASONING_EFFORTS.length) {
        break;
      }
    }
  }

  return efforts;
}

function uniqueStrings(value: unknown): readonly string[] | null {
  const candidates = boundedArray(value);
  if (candidates === undefined) {
    return null;
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (selected.length >= MAXIMUM_MODEL_METADATA_ITEMS) {
      break;
    }
    if (typeof item !== "string" || item.length === 0) {
      continue;
    }
    const bounded = utf8Prefix(item, MAXIMUM_MODEL_METADATA_TEXT_BYTES);
    if (bounded.length > 0 && !seen.has(bounded)) {
      seen.add(bounded);
      selected.push(bounded);
    }
  }
  return selected;
}

function nestedValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  parentKey: string,
): unknown {
  const direct = value[key];

  if (direct !== undefined) {
    return direct;
  }

  const parent = value[parentKey];
  return isRecord(parent) ? parent[key] : undefined;
}

type ContextWindowRecord = Readonly<Record<string, unknown>>;

function modelContextWindow(
  value: ContextWindowRecord,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const contextWindow = readPositiveSafeInteger(
      nestedValue(value, key, "capabilities"),
    );

    if (contextWindow !== null) {
      return contextWindow;
    }
  }

  return null;
}

function modelPricing(value: unknown): ProviderModelPricing | null {
  if (!isRecord(value)) {
    return null;
  }

  const pricing: Partial<
    Record<
      "cacheWriteInput" | "cachedInput" | "input" | "output",
      string | number
    >
  > = {};
  const add = (
    target: "cacheWriteInput" | "cachedInput" | "input" | "output",
    keys: readonly string[],
  ): void => {
    for (const key of keys) {
      const price = value[key];
      const boundedPrice =
        typeof price === "string"
          ? utf8Prefix(price.trim(), MAXIMUM_MODEL_METADATA_TEXT_BYTES)
          : price;
      if (
        (typeof boundedPrice === "string" && boundedPrice.length > 0) ||
        (typeof boundedPrice === "number" &&
          Number.isFinite(boundedPrice) &&
          boundedPrice >= 0)
      ) {
        pricing[target] = boundedPrice;
        return;
      }
    }
  };
  add("cacheWriteInput", ["cache_write_input", "input_cache_write"]);
  add("cachedInput", ["cached_input", "input_cache_read"]);
  add("input", ["prompt", "input"]);
  add("output", ["completion", "output"]);
  return Object.keys(pricing).length === 0 ? null : pricing;
}

function modelOption(
  value: unknown,
  idKey: string,
  labelKey: string,
  efforts: readonly AgentReasoningEffort[],
  contextKeys: readonly string[],
): AgentModelOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value[idKey];

  if (!isAgentModelId(id)) {
    return undefined;
  }

  return {
    contextWindow: modelContextWindow(value, contextKeys),
    ...(typeof value["fallback_prompt"] === "string"
      ? {
          fallbackPrompt:
            utf8Prefix(
              value["fallback_prompt"].trim(),
              MAXIMUM_MODEL_FALLBACK_PROMPT_BYTES,
            ) || null,
        }
      : {}),
    id,
    inputModalities: uniqueStrings(
      nestedValue(value, "input_modalities", "architecture"),
    ),
    label: modelLabel(value[labelKey], id),
    outputModalities: uniqueStrings(
      nestedValue(value, "output_modalities", "architecture"),
    ),
    pricing: modelPricing(value["pricing"]),
    reasoningEfforts: efforts,
  };
}

function uniqueModels(
  models: readonly AgentModelOption[],
): readonly AgentModelOption[] {
  const ids = new Set<string>();
  return models.filter((model) => {
    if (ids.has(model.id)) {
      return false;
    }

    ids.add(model.id);
    return true;
  });
}

function createCatalog(models: readonly AgentModelOption[]): AgentModelCatalog {
  const unique = uniqueModels(models);
  return { defaultModel: unique[0]?.id ?? null, models: unique };
}

function providerModelList(value: unknown, key: string): readonly unknown[] {
  const items = readRequiredArray(
    value,
    key,
    "The provider returned an invalid model catalog",
  );
  if (items.length > MAXIMUM_AGENT_MODEL_OPTIONS) {
    throw modelDiscoveryError(MODEL_CATALOG_HAS_TOO_MANY_OPTIONS);
  }
  return items;
}

function readCodexCatalog(value: unknown): AgentModelCatalog {
  const models: PrioritizedModel[] = [];

  for (const item of providerModelList(value, "models")) {
    if (!isRecord(item) || item["visibility"] !== "list") {
      continue;
    }

    const model = modelOption(
      item,
      "slug",
      "display_name",
      reasoningEfforts(item["supported_reasoning_levels"]),
      ["context_window", "context_window_size"],
    );

    if (model !== undefined) {
      const priority = item["priority"];
      models.push({
        model,
        priority:
          typeof priority === "number" && Number.isFinite(priority)
            ? priority
            : Number.MAX_SAFE_INTEGER,
      });
    }
  }

  models.sort((left, right) => left.priority - right.priority);
  return createCatalog(models.map(({ model }) => model));
}

function supportsParameter(value: unknown, parameter: string): boolean {
  return (
    Array.isArray(value) &&
    value
      .slice(0, MAXIMUM_MODEL_METADATA_INPUT_ITEMS)
      .some((item) => item === parameter)
  );
}

function openRouterReasoningEfforts(
  value: Readonly<Record<string, unknown>>,
): readonly AgentReasoningEffort[] {
  const reasoning = value["reasoning"];
  const supported = isRecord(reasoning)
    ? reasoning["supported_efforts"]
    : undefined;
  return Array.isArray(supported) ? reasoningEfforts(supported) : [];
}

function readOpenRouterCatalog(value: unknown): AgentModelCatalog {
  const models: AgentModelOption[] = [];

  for (const item of providerModelList(value, "data")) {
    if (!isRecord(item)) {
      continue;
    }

    const supportedParameters = item["supported_parameters"];

    if (!supportsParameter(supportedParameters, "tools")) {
      continue;
    }

    const model = modelOption(
      item,
      "id",
      "name",
      openRouterReasoningEfforts(item),
      ["context_length"],
    );

    if (model !== undefined) {
      models.push(model);
    }
  }

  return createCatalog(models);
}

// OpenAI's standard model list has no capability metadata, so exclude known
// non-chat families while retaining current and future GPT/o-series IDs.
function supportsOpenAiAgentLoop(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const supportedFamily =
    normalized.startsWith("gpt-") ||
    normalized.startsWith("chatgpt-") ||
    normalized.startsWith("codex-") ||
    normalized.startsWith("ft:gpt-") ||
    /^o\d/u.test(normalized) ||
    /^ft:o\d/u.test(normalized);
  return (
    supportedFamily &&
    !INCOMPATIBLE_OPENAI_MODEL_MARKERS.some((marker) =>
      normalized.includes(marker),
    )
  );
}

function genericReasoningEfforts(
  entry: Readonly<Record<string, unknown>>,
): readonly AgentReasoningEffort[] {
  const nested = entry["reasoning"];
  return reasoningEfforts(
    entry["supported_reasoning_levels"] ??
      entry["supported_reasoning_efforts"] ??
      (isRecord(nested) ? nested["supported_efforts"] : undefined),
  );
}

function genericModelOption(
  item: unknown,
  anthropicFormat: boolean,
): AgentModelOption | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  return modelOption(
    item,
    "id",
    anthropicFormat ? "display_name" : "name",
    genericReasoningEfforts(item),
    [
      "context_window",
      "context_window_size",
      "context_length",
      "max_input_tokens",
    ],
  );
}

function readGenericCatalog(value: unknown): AgentModelCatalog {
  const models = providerModelList(value, "data").flatMap((item) => {
    const option = genericModelOption(item, false);
    return option === undefined ? [] : [option];
  });
  return createCatalog(models);
}

function readAnthropicCatalog(items: readonly unknown[]): {
  readonly catalog: AgentModelCatalog;
  readonly unknownEffortIds: ReadonlySet<string>;
} {
  const unknownEffortIds = new Set<string>();
  const seen = new Set<string>();
  const models = items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const option = genericModelOption(item, true);
    if (option === undefined) {
      return [];
    }
    const { effortsAuthoritative, option: model } = withAnthropicCapabilities(
      option,
      item,
    );
    // The catalog keeps the first ID occurrence; only its authority counts.
    if (!seen.has(model.id)) {
      seen.add(model.id);
      if (!effortsAuthoritative) {
        unknownEffortIds.add(model.id);
      }
    }
    return [model];
  });
  return { catalog: createCatalog(models), unknownEffortIds };
}

// Dual-format endpoints publish `supported_reasoning_efforts` on their
// OpenAI-style listing at the same base URL; merge it best-effort.
async function fetchDiscoveryJson(
  fetch: AgentModelDiscoveryFetch,
  url: URL | string,
  headers: Headers,
): Promise<unknown> {
  return readProviderResponse(
    await fetch(
      new Request(url, {
        headers,
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  );
}

async function mergeOpenAiListedEfforts(
  catalog: AgentModelCatalog,
  unknownEffortIds: ReadonlySet<string>,
  credential: AgentProviderCredential,
  fetch: AgentModelDiscoveryFetch,
): Promise<AgentModelCatalog> {
  // Only metadata-free models are eligible; authoritative answers
  // (including explicit non-support) stay.
  if (unknownEffortIds.size === 0) {
    return catalog;
  }
  try {
    const headers = new Headers({ accept: "application/json" });
    if (credential.secret.length > 0) {
      headers.set("authorization", `Bearer ${credential.secret}`);
    }
    const value = await fetchDiscoveryJson(
      fetch,
      genericProviderEndpoint(credential.baseUrl, "models"),
      headers,
    );
    const efforts = new Map<string, readonly AgentReasoningEffort[]>();
    for (const item of providerModelList(value, "data")) {
      if (isRecord(item) && typeof item["id"] === "string") {
        const listed = genericReasoningEfforts(item);
        if (listed.length > 0) {
          efforts.set(item["id"], listed);
        }
      }
    }
    if (efforts.size === 0) {
      return catalog;
    }
    return {
      ...catalog,
      models: catalog.models.map((model) => {
        const listed = efforts.get(model.id);
        return listed === undefined || !unknownEffortIds.has(model.id)
          ? model
          : { ...model, reasoningEfforts: listed };
      }),
    };
  } catch {
    return catalog;
  }
}

function readOpenAiCatalog(value: unknown): AgentModelCatalog {
  const models = providerModelList(value, "data")
    .map((item) =>
      modelOption(
        item,
        "id",
        "id",
        [],
        ["context_window", "context_window_size"],
      ),
    )
    .filter(
      (model): model is AgentModelOption =>
        model !== undefined && supportsOpenAiAgentLoop(model.id),
    );
  return createCatalog(models);
}

async function readProviderResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw modelDiscoveryError(
      `Model discovery failed with status ${String(response.status)}`,
      response.status,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAXIMUM_RESPONSE_LENGTH
  ) {
    throw modelDiscoveryError(MODEL_CATALOG_TOO_LARGE);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    return null;
  }
  const bytes = Buffer.allocUnsafe(MAXIMUM_RESPONSE_LENGTH);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (length + value.byteLength > MAXIMUM_RESPONSE_LENGTH) {
        await reader.cancel().catch(() => undefined);
        throw modelDiscoveryError(MODEL_CATALOG_TOO_LARGE);
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    throw modelDiscoveryError("The provider returned an invalid model catalog");
  }
}

function discoveryRequest(
  provider: ProviderId,
  credential: AgentProviderCredential,
): { readonly headers: Headers; readonly url: string } {
  const codexOAuth = provider === "openai" && credential.source === "oauth";
  const url = codexOAuth
    ? `${OPENAI_CODEX_MODELS_URL}?client_version=${MODEL_CLIENT_VERSION}`
    : provider === "openai"
      ? OPENAI_MODELS_URL
      : provider === "openrouter"
        ? OPENROUTER_MODELS_URL
        : genericProviderEndpoint(credential.baseUrl, "models");
  const headers = agentProviderRequestHeaders(
    provider,
    credential,
    "application/json",
  );
  headers.delete("content-type");
  return { headers, url };
}

// Anthropic Models pages with `has_more`/`last_id` (20-item default);
// request the documented 1000-item maximum. A page claiming more must
// carry a fresh nonempty cursor and items — never loop or truncate —
// within a default-page-size crawl budget.
const MAXIMUM_ANTHROPIC_CATALOG_PAGES = MAXIMUM_AGENT_MODEL_OPTIONS / 20;

async function readAnthropicModelList(
  credential: AgentProviderCredential,
  fetch: AgentModelDiscoveryFetch,
): Promise<readonly unknown[]> {
  const base = discoveryRequest("generic", credential);
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | undefined;
  while (seenCursors.size < MAXIMUM_ANTHROPIC_CATALOG_PAGES) {
    const url = new URL(base.url);
    url.searchParams.set("limit", "1000");
    if (afterId !== undefined) {
      url.searchParams.set("after_id", afterId);
    }
    const value = await fetchDiscoveryJson(fetch, url, base.headers);
    const page = providerModelList(value, "data");
    items.push(...page);
    if (items.length > MAXIMUM_AGENT_MODEL_OPTIONS) {
      throw modelDiscoveryError(MODEL_CATALOG_HAS_TOO_MANY_OPTIONS);
    }
    if (!isRecord(value) || value["has_more"] !== true) {
      return items;
    }
    const lastId = value["last_id"];
    if (
      typeof lastId !== "string" ||
      lastId.length === 0 ||
      seenCursors.has(lastId) ||
      page.length === 0
    ) {
      throw modelDiscoveryError(
        "The provider returned an inconsistent model catalog page",
      );
    }
    seenCursors.add(lastId);
    afterId = lastId;
  }
  // Pages were well-formed; the crawl budget ran out.
  throw modelDiscoveryError(MODEL_CATALOG_HAS_TOO_MANY_OPTIONS);
}

export async function discoverAgentModels(
  provider: ProviderId,
  credential: AgentProviderCredential,
  fetch: AgentModelDiscoveryFetch = (request) => globalThis.fetch(request),
): Promise<AgentModelCatalog> {
  try {
    if (provider === "generic" && credential.apiFormat === "anthropic") {
      const { catalog, unknownEffortIds } = readAnthropicCatalog(
        await readAnthropicModelList(credential, fetch),
      );
      return await mergeOpenAiListedEfforts(
        catalog,
        unknownEffortIds,
        credential,
        fetch,
      );
    }
    const request = discoveryRequest(provider, credential);
    const value = await fetchDiscoveryJson(fetch, request.url, request.headers);

    if (provider === "openrouter") {
      return readOpenRouterCatalog(value);
    }
    if (provider === "generic") {
      return readGenericCatalog(value);
    }

    return credential.source === "oauth"
      ? readCodexCatalog(value)
      : readOpenAiCatalog(value);
  } catch (error) {
    if (error instanceof AgentModelDiscoveryError) {
      throw error;
    }
    throw modelDiscoveryError(safeAgentModelDiscoveryError(error));
  }
}
