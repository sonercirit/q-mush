import type { AgentModelStep } from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { AgentProviderCredential } from "./agent-model-options.ts";
import {
  fetchModelRequestAttempt,
  modelResponseRetryAfterMilliseconds,
  RetryableModelRequestError,
  runModelRequestWithRetries,
  type ModelRequestSleep,
} from "./agent-model-retry.ts";
import type { AgentModelFetch } from "./agent-model.ts";
import { anthropicReplayIdentityInput } from "./anthropic-replay-identity-input.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import { ProviderStreamError } from "./provider-error.ts";
import {
  readProviderEventStream,
  type AnthropicEventStreamOptions,
} from "./provider-event-stream.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "./provider-stream.ts";

export interface ProviderHttpOptions {
  readonly body: unknown;
  readonly credential: AgentProviderCredential;
  readonly credentialFingerprint: string;
  readonly fetch: AgentModelFetch;
  readonly headers: Headers;
  readonly model: string;
  readonly onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly onStreamRetry?: () => void;
  readonly protocol: "anthropic" | "chat_completions" | "responses";
  readonly provider: ProviderId;
  readonly resolvedModel?: string;
  readonly sleep: ModelRequestSleep | undefined;
  readonly url: string;
}

function providerName(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "generic":
      return "Generic provider";
  }
}

function errorDetail(body: string): string {
  const fallback = body.trim();
  if (fallback.length === 0) {
    return "";
  }

  let value: unknown;
  try {
    value = JSON.parse(fallback);
  } catch {
    return fallback;
  }

  if (!isRecord(value)) {
    return fallback;
  }

  const error = value["error"];
  const errorMessage = isRecord(error) ? error["message"] : error;
  const detail = errorMessage ?? value["message"] ?? value["detail"];
  const metadata = isRecord(error) ? error["metadata"] : undefined;
  const raw = isRecord(metadata) ? metadata["raw"] : undefined;
  return (
    [detail, raw]
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
      .map((part) => part.trim())
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(": ") || fallback
  );
}

async function requestError(
  provider: ProviderId,
  response: Response,
): Promise<Error> {
  const summary = `${providerName(provider)} request failed with status ${String(response.status)}`;

  try {
    const detail = errorDetail(await response.text());
    return new Error(detail.length === 0 ? summary : `${summary}: ${detail}`);
  } catch {
    return new Error(summary);
  }
}

function streamFailure(
  error: unknown,
  response: Response,
): RetryableModelRequestError | ProviderStreamError {
  if (error instanceof ProviderStreamError && !error.transient) {
    return error;
  }
  const retryAfterMilliseconds =
    error instanceof ProviderStreamError
      ? error.retryAfterMilliseconds
      : modelResponseRetryAfterMilliseconds(response);
  return new RetryableModelRequestError(error, { retryAfterMilliseconds });
}

function anthropicStreamOptions(
  options: ProviderHttpOptions,
): AnthropicEventStreamOptions {
  const identity = anthropicReplayIdentityFrom(
    anthropicReplayIdentityInput(options),
  );
  return options.onDelta === undefined
    ? { identity }
    : { identity, onDelta: options.onDelta };
}

async function readAcceptedResponse(
  response: Response,
  options: ProviderHttpOptions,
): Promise<AgentModelStep> {
  if (!response.ok) {
    throw await requestError(options.provider, response);
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    const accumulator =
      options.protocol === "anthropic"
        ? createProviderStreamAccumulator(
            "anthropic",
            anthropicStreamOptions(options),
          )
        : createProviderStreamAccumulator(
            "chat_completions_json",
            options.onDelta,
          );
    try {
      accumulator.push(await response.json());
      return accumulator.finish();
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new RetryableModelRequestError(error, {
          retryAfterMilliseconds: modelResponseRetryAfterMilliseconds(response),
        });
      }
      throw error;
    }
  }

  try {
    return options.protocol === "anthropic"
      ? await readProviderEventStream(
          response,
          "anthropic",
          anthropicStreamOptions(options),
        )
      : await readProviderEventStream(
          response,
          options.protocol,
          options.onDelta,
        );
  } catch (error) {
    throw streamFailure(error, response);
  }
}

export async function completeProviderHttp(
  options: ProviderHttpOptions,
  signal?: AbortSignal,
): Promise<AgentModelStep> {
  const request = new Request(options.url, {
    body: JSON.stringify(options.body),
    headers: options.headers,
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  let streamed = false;
  const retryAttempt = async (): Promise<AgentModelStep> => {
    const response = await fetchModelRequestAttempt(options.fetch, request);
    try {
      return await readAcceptedResponse(response, {
        ...options,
        onDelta: (delta) => {
          streamed = true;
          options.onDelta?.(delta);
        },
      });
    } catch (error) {
      if (streamed && error instanceof RetryableModelRequestError) {
        options.onDelta?.({ content: "", reset: true, thinking: "" });
        options.onStreamRetry?.();
        streamed = false;
      }
      throw error;
    }
  };

  try {
    return await runModelRequestWithRetries(
      retryAttempt,
      request.signal,
      options.sleep,
    );
  } catch (error) {
    if (error instanceof RetryableModelRequestError) {
      if (error.response !== undefined) {
        throw await requestError(options.provider, error.response);
      }
      throw error.failure;
    }
    throw error;
  }
}
