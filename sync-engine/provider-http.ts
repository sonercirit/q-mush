import type { AgentModelTurn } from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import {
  fetchModelRequestWithRetries,
  type ModelRequestSleep,
} from "./agent-model-retry.ts";
import type { AgentModelFetch } from "./agent-model.ts";
import { readProviderEventStream } from "./provider-event-stream.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "./provider-stream.ts";

export interface ProviderHttpOptions {
  readonly body: unknown;
  readonly fetch: AgentModelFetch;
  readonly headers: Headers;
  readonly onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly provider: ProviderId;
  readonly responsesProtocol: boolean;
  readonly sleep: ModelRequestSleep | undefined;
  readonly url: string;
}

function providerName(provider: ProviderId): string {
  return provider === "openai" ? "OpenAI" : "OpenRouter";
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
  return typeof detail === "string" && detail.trim().length > 0
    ? detail.trim()
    : fallback;
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

export async function completeProviderHttp(
  options: ProviderHttpOptions,
  signal?: AbortSignal,
): Promise<AgentModelTurn> {
  const request = new Request(options.url, {
    body: JSON.stringify(options.body),
    headers: options.headers,
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  const response = await fetchModelRequestWithRetries(
    options.fetch,
    request,
    options.sleep,
  );

  if (!response.ok) {
    throw await requestError(options.provider, response);
  }

  if (response.headers.get("content-type")?.includes("application/json")) {
    const accumulator = createProviderStreamAccumulator(
      "chat_completions_json",
      options.onDelta,
    );
    accumulator.push(await response.json());
    return accumulator.finish();
  }

  return readProviderEventStream(
    response,
    options.responsesProtocol ? "responses" : "chat_completions",
    options.onDelta,
  );
}
