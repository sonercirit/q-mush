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

export interface AnthropicModelResolution {
  readonly model?: string;
  readonly retryable: boolean;
}

function resolvedModel(model: string): AnthropicModelResolution {
  return { model, retryable: false };
}

function unresolvedModel(retryable = false): AnthropicModelResolution {
  return { retryable };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

const RETRYABLE_TRANSPORT_FAILURE = Symbol("retryable transport failure");

async function transportAttempt<Value>(
  attempt: () => Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value | typeof RETRYABLE_TRANSPORT_FAILURE> {
  try {
    return await attempt();
  } catch {
    throwIfCallerAborted(signal);
    return RETRYABLE_TRANSPORT_FAILURE;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function resolveAnthropicModelAttempt(options: {
  readonly credential: AgentProviderCredential;
  readonly fetch: AnthropicModelResolutionFetch;
  readonly model: string;
  readonly provider: ProviderId;
  readonly signal?: AbortSignal;
}): Promise<AnthropicModelResolution> {
  if (!usesAnthropicFormat(options.provider, options.credential)) {
    return resolvedModel(options.model);
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
  const response = await transportAttempt(
    () =>
      options.fetch(
        new Request(
          `${genericProviderEndpoint(options.credential.baseUrl, "models")}/${encodeURIComponent(options.model)}`,
          { headers, method: "GET", signal },
        ),
      ),
    options.signal,
  );
  if (response === RETRYABLE_TRANSPORT_FAILURE) {
    return unresolvedModel(true);
  }
  throwIfCallerAborted(options.signal);
  if (!response.ok) {
    return unresolvedModel(retryableStatus(response.status));
  }
  const value = await transportAttempt(
    () => responseJson(response),
    options.signal,
  );
  if (value === RETRYABLE_TRANSPORT_FAILURE) {
    return unresolvedModel(true);
  }
  throwIfCallerAborted(options.signal);
  const id = isRecord(value) ? value["id"] : undefined;
  return isAgentModelId(id) ? resolvedModel(id) : unresolvedModel();
}
