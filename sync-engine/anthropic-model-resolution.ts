import { isAgentModelId } from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  usesAnthropicFormat,
  type AgentProviderCredential,
} from "./agent-model-options.ts";
import { ANTHROPIC_VERSION } from "./anthropic-request.ts";
import { genericProviderEndpoint } from "./generic-provider-url.ts";

const ANTHROPIC_MODEL_RESOLUTION_ERROR =
  "The Anthropic model alias could not be resolved";

export type AnthropicModelResolutionFetch = (
  request: Request,
) => Promise<Response>;

export async function resolveAnthropicModel(options: {
  readonly credential: AgentProviderCredential;
  readonly fetch: AnthropicModelResolutionFetch;
  readonly model: string;
  readonly provider: ProviderId;
  readonly signal?: AbortSignal;
}): Promise<string> {
  if (!usesAnthropicFormat(options.provider, options.credential)) {
    return options.model;
  }
  const headers = new Headers({
    accept: "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  });
  if (options.credential.secret.length > 0) {
    headers.set("x-api-key", options.credential.secret);
  }
  const timeout = AbortSignal.timeout(10_000);
  const signal =
    options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
  const response = await options.fetch(
    new Request(
      `${genericProviderEndpoint(options.credential.baseUrl, "models")}/${encodeURIComponent(options.model)}`,
      { headers, method: "GET", signal },
    ),
  );
  if (!response.ok) {
    throw new Error(ANTHROPIC_MODEL_RESOLUTION_ERROR);
  }
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error(ANTHROPIC_MODEL_RESOLUTION_ERROR);
  }
  const id = isRecord(value) ? value["id"] : undefined;
  if (!isAgentModelId(id)) {
    throw new Error(ANTHROPIC_MODEL_RESOLUTION_ERROR);
  }
  return id;
}
