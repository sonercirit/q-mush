import {
  AGENT_REASONING_EFFORTS,
  MAXIMUM_AGENT_MODEL_OPTIONS,
  defaultAgentModel,
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
import {
  agentProviderRequestHeaders,
  type AgentProviderCredential,
} from "./agent-model.ts";

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

class AgentModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelDiscoveryError";
  }
}

function modelDiscoveryError(message: string): AgentModelDiscoveryError {
  return new AgentModelDiscoveryError(message);
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

function createCatalog(
  models: readonly AgentModelOption[],
  preferredDefault?: string,
): AgentModelCatalog {
  const unique = uniqueModels(models);
  const defaultModel =
    unique.find(({ id }) => id === preferredDefault)?.id ??
    unique[0]?.id ??
    null;
  return { defaultModel, models: unique };
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
  supportedParameters: unknown,
): readonly AgentReasoningEffort[] {
  const reasoning = value["reasoning"];

  if (isRecord(reasoning)) {
    const supported = reasoning["supported_efforts"];

    if (supported === null) {
      return AGENT_REASONING_EFFORTS;
    }

    if (Array.isArray(supported)) {
      return reasoningEfforts(supported);
    }
  }

  return supportsParameter(supportedParameters, "reasoning") ||
    supportsParameter(supportedParameters, "reasoning_effort")
    ? AGENT_REASONING_EFFORTS
    : [];
}

function readOpenRouterCatalog(
  value: unknown,
  credential: ProviderCredentialAccess,
): AgentModelCatalog {
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
      openRouterReasoningEfforts(item, supportedParameters),
      ["context_length"],
    );

    if (model !== undefined) {
      models.push(model);
    }
  }

  return createCatalog(
    models,
    defaultAgentModel("openrouter", credential.source),
  );
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

function readOpenAiCatalog(
  value: unknown,
  credential: ProviderCredentialAccess,
): AgentModelCatalog {
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
  return createCatalog(models, defaultAgentModel("openai", credential.source));
}

async function readProviderResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw modelDiscoveryError(
      `Model discovery failed with status ${String(response.status)}`,
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
): Request {
  const codexOAuth = provider === "openai" && credential.source === "oauth";
  const url = codexOAuth
    ? `${OPENAI_CODEX_MODELS_URL}?client_version=${MODEL_CLIENT_VERSION}`
    : provider === "openai"
      ? OPENAI_MODELS_URL
      : OPENROUTER_MODELS_URL;
  const headers = agentProviderRequestHeaders(
    provider,
    credential,
    "application/json",
  );
  headers.delete("content-type");
  return new Request(url, {
    headers,
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function discoverAgentModels(
  provider: ProviderId,
  credential: ProviderCredentialAccess,
  fetch: AgentModelDiscoveryFetch = (request) => globalThis.fetch(request),
): Promise<AgentModelCatalog> {
  try {
    const value = await readProviderResponse(
      await fetch(discoveryRequest(provider, credential)),
    );

    if (provider === "openrouter") {
      return readOpenRouterCatalog(value, credential);
    }

    return credential.source === "oauth"
      ? readCodexCatalog(value)
      : readOpenAiCatalog(value, credential);
  } catch (error) {
    throw modelDiscoveryError(safeAgentModelDiscoveryError(error));
  }
}
