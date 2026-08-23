import { isAgentModelId } from "../shared/agent-configuration.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { readAnthropicModelList } from "./agent-model-discovery-anthropic.ts";
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

function modelListPage(value: unknown): readonly unknown[] {
  const data = isRecord(value) ? value["data"] : undefined;
  return Array.isArray(data) ? data : [];
}

function listRequestError(retryable: boolean): Error {
  return new Error("The Anthropic model list request failed", {
    cause: retryable,
  });
}

async function resolveAnthropicModelFromList(options: {
  readonly callerSignal?: AbortSignal;
  readonly fetch: AnthropicModelResolutionFetch;
  readonly headers: Headers;
  readonly listUrl: string;
  readonly model: string;
  readonly requestSignal: AbortSignal;
}): Promise<AnthropicModelResolution> {
  try {
    const entries = await readAnthropicModelList({
      fetchJson: async (url) => {
        const response = await transportAttempt(
          () =>
            options.fetch(
              new Request(url, {
                headers: options.headers,
                signal: options.requestSignal,
              }),
            ),
          options.callerSignal,
        );
        if (response === RETRYABLE_TRANSPORT_FAILURE) {
          throw listRequestError(true);
        }
        throwIfCallerAborted(options.callerSignal);
        if (!response.ok) {
          throw listRequestError(retryableStatus(response.status));
        }
        const value = await transportAttempt(
          () => responseJson(response),
          options.callerSignal,
        );
        if (value === RETRYABLE_TRANSPORT_FAILURE) {
          throw listRequestError(true);
        }
        throwIfCallerAborted(options.callerSignal);
        return value;
      },
      listUrl: options.listUrl,
      pageError: (message) => new Error(message),
      readPage: modelListPage,
      tooManyOptionsError: () =>
        new Error("The Anthropic model list is too large"),
    });
    return entries.some(
      (entry) => isRecord(entry) && entry["id"] === options.model,
    )
      ? resolvedModel(options.model)
      : unresolvedModel();
  } catch (error) {
    throwIfCallerAborted(options.callerSignal);
    return unresolvedModel(error instanceof Error && error.cause === true);
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
  const modelsUrl = genericProviderEndpoint(
    options.credential.baseUrl,
    "models",
  );
  const response = await transportAttempt(
    () =>
      options.fetch(
        new Request(`${modelsUrl}/${encodeURIComponent(options.model)}`, {
          headers,
          method: "GET",
          signal,
        }),
      ),
    options.signal,
  );
  if (response === RETRYABLE_TRANSPORT_FAILURE) {
    return unresolvedModel(true);
  }
  throwIfCallerAborted(options.signal);
  if (!response.ok && retryableStatus(response.status)) {
    return unresolvedModel(true);
  }
  if (response.ok) {
    const value = await transportAttempt(
      () => responseJson(response),
      options.signal,
    );
    if (value === RETRYABLE_TRANSPORT_FAILURE) {
      return unresolvedModel(true);
    }
    throwIfCallerAborted(options.signal);
    const id = isRecord(value) ? value["id"] : undefined;
    if (isAgentModelId(id)) {
      return resolvedModel(id);
    }
  } else if (response.status === 401 || response.status === 403) {
    return unresolvedModel();
  }
  return resolveAnthropicModelFromList({
    ...(options.signal === undefined ? {} : { callerSignal: options.signal }),
    fetch: options.fetch,
    headers,
    listUrl: modelsUrl,
    model: options.model,
    requestSignal: signal,
  });
}
