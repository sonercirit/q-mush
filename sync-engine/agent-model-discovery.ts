import {
  MAXIMUM_AGENT_MODEL_OPTIONS,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { isRecord, readRequiredArray } from "../shared/auth-model.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import {
  readAnthropicModelList,
  withAnthropicCapabilities,
} from "./agent-model-discovery-anthropic.ts";
import {
  AgentModelDiscoveryError,
  fetchDiscoveryJson,
  modelDiscoveryError,
  safeAgentModelDiscoveryError,
  type AgentModelDiscoveryFetch,
} from "./agent-model-discovery-fetch.ts";
import {
  modelOption,
  reasoningEfforts,
} from "./agent-model-discovery-option.ts";
import {
  usesAnthropicFormat,
  type AgentProviderDiscoveryCredential,
} from "./agent-model-options.ts";
import { agentProviderRequestHeaders } from "./agent-model.ts";
import { genericProviderEndpoint } from "./generic-provider-url.ts";

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const MODEL_CLIENT_VERSION = "1.0.0";
const MAXIMUM_MODEL_METADATA_INPUT_ITEMS = 100;
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

export type AgentModelDiscoverer = (
  provider: ProviderId,
  credential: ProviderCredentialAccess,
  signal?: AbortSignal,
) => Promise<AgentModelCatalog>;

export async function discoverModelOption(
  discover: AgentModelDiscoverer,
  provider: ProviderId,
  credential: ProviderCredentialAccess,
  model: string,
  signal?: AbortSignal,
): Promise<AgentModelOption | undefined> {
  const catalog = await discover(provider, credential, signal);
  return catalog.models.find(({ id }) => id === model);
}

interface PrioritizedModel {
  readonly model: AgentModelOption;
  readonly priority: number;
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

// OpenAI's standard list has no capability metadata; exclude known non-chat
// families while retaining current and future GPT/o-series IDs.
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
    // Anthropic's Models API lists `max_tokens` (maximum output tokens);
    // OpenAI-style listings lack it.
    anthropicFormat ? ["max_tokens", "max_output_tokens"] : [],
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
// OpenAI-style listing at the same base URL.
async function mergeOpenAiListedEfforts(
  catalog: AgentModelCatalog,
  unknownEffortIds: ReadonlySet<string>,
  source: {
    readonly credential: AgentProviderDiscoveryCredential;
    readonly fetch: AgentModelDiscoveryFetch;
    readonly signal?: AbortSignal;
  },
): Promise<AgentModelCatalog> {
  // Only metadata-free models are eligible; authoritative answers
  // (including explicit non-support) stay.
  if (unknownEffortIds.size === 0) {
    return catalog;
  }
  const { credential, fetch, signal } = source;
  try {
    const headers = new Headers({ accept: "application/json" });
    if (credential.secret.length > 0) {
      headers.set("authorization", `Bearer ${credential.secret}`);
    }
    const value = await fetchDiscoveryJson(
      fetch,
      genericProviderEndpoint(credential.baseUrl, "models"),
      headers,
      signal,
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
  } catch (error) {
    // Best-effort probe, but the caller's own cancellation must surface
    // instead of resolving a canceled discovery successfully.
    if (signal?.aborted !== true) {
      return catalog;
    }
    throw error;
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

function discoveryRequest(
  provider: ProviderId,
  credential: AgentProviderDiscoveryCredential,
): { readonly headers: Headers; readonly url: string } {
  const codexOAuth = provider === "openai" && credential.source === "oauth";
  const url = codexOAuth
    ? `${OPENAI_CODEX_MODELS_URL}?client_version=${MODEL_CLIENT_VERSION}`
    : provider === "openai"
      ? OPENAI_MODELS_URL
      : provider === "openrouter"
        ? OPENROUTER_MODELS_URL
        : genericProviderEndpoint(credential.baseUrl, "models");
  const headers = agentProviderRequestHeaders(provider, credential, {
    accept: "application/json",
  });
  headers.delete("content-type");
  return { headers, url };
}

export async function discoverAgentModels(
  provider: ProviderId,
  credential: AgentProviderDiscoveryCredential,
  signal?: AbortSignal,
): Promise<AgentModelCatalog> {
  return discoverAgentModelsWithFetch(
    provider,
    credential,
    (request) => globalThis.fetch(request),
    signal,
  );
}

export async function discoverAgentModelsWithFetch(
  provider: ProviderId,
  credential: AgentProviderDiscoveryCredential,
  fetch: AgentModelDiscoveryFetch,
  signal?: AbortSignal,
): Promise<AgentModelCatalog> {
  try {
    if (usesAnthropicFormat(provider, credential)) {
      const base = discoveryRequest("generic", credential);
      const { catalog, unknownEffortIds } = readAnthropicCatalog(
        await readAnthropicModelList({
          fetchJson: (url) =>
            fetchDiscoveryJson(fetch, url, base.headers, signal),
          listUrl: base.url,
          pageError: modelDiscoveryError,
          readPage: (value) => providerModelList(value, "data"),
          tooManyOptionsError: () =>
            modelDiscoveryError(MODEL_CATALOG_HAS_TOO_MANY_OPTIONS),
        }),
      );
      return await mergeOpenAiListedEfforts(catalog, unknownEffortIds, {
        credential,
        fetch,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const request = discoveryRequest(provider, credential);
    const value = await fetchDiscoveryJson(
      fetch,
      request.url,
      request.headers,
      signal,
    );

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
    // Cancellation is the caller's own deadline or stop, not a provider
    // failure; propagate it unwrapped.
    if (error instanceof AgentModelDiscoveryError || signal?.aborted === true) {
      throw error;
    }
    throw modelDiscoveryError(safeAgentModelDiscoveryError(error));
  }
}
