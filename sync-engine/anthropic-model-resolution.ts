import { isAgentModelId } from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  usesAnthropicFormat,
  type AgentProviderCredential,
} from "./agent-model-options.ts";
import { ANTHROPIC_VERSION } from "./anthropic-request.ts";
import { genericProviderEndpoint } from "./generic-provider-url.ts";

export type AnthropicModelResolutionFetch = (
  request: Request,
) => Promise<Response>;

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

export async function resolveAnthropicModel(options: {
  readonly credential: AgentProviderCredential;
  readonly fetch: AnthropicModelResolutionFetch;
  readonly model: string;
  readonly provider: ProviderId;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
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
  let response: Response;
  try {
    response = await options.fetch(
      new Request(
        `${genericProviderEndpoint(options.credential.baseUrl, "models")}/${encodeURIComponent(options.model)}`,
        { headers, method: "GET", signal },
      ),
    );
  } catch {
    throwIfCallerAborted(options.signal);
    return undefined;
  }
  throwIfCallerAborted(options.signal);
  if (!response.ok) {
    return undefined;
  }
  const value = await responseJson(response);
  throwIfCallerAborted(options.signal);
  const id = isRecord(value) ? value["id"] : undefined;
  return isAgentModelId(id) ? id : undefined;
}
