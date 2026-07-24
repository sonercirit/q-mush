import { setTimeout } from "node:timers/promises";

const MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000] as const;
const MODEL_REQUEST_MAX_RETRY_DELAY_MILLISECONDS =
  MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.at(-1) ?? 4_000;
const RATE_LIMITED_MODEL_REQUEST_STATUS = 429;
const RETRYABLE_MODEL_REQUEST_STATUSES = new Set([
  408,
  409,
  RATE_LIMITED_MODEL_REQUEST_STATUS,
]);
const RETRY_AFTER_MAX_MILLISECONDS = 60_000;
const RATE_LIMIT_RETRY_MAXIMUM_ATTEMPTS = 12;

type ModelRequestFetch = (request: Request) => Promise<Response>;
type ModelRequestResult =
  | { readonly error: unknown; readonly type: "error" }
  | { readonly response: Response; readonly type: "response" };
export type ModelRequestSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

function defaultModelRequestSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return setTimeout(milliseconds, undefined, { signal });
}

async function fetchModelRequest(
  fetch: ModelRequestFetch,
  request: Request,
): Promise<ModelRequestResult> {
  try {
    return { response: await fetch(request.clone()), type: "response" };
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    return { error, type: "error" };
  }
}

function modelRequestIsRetryable(result: ModelRequestResult): boolean {
  return (
    result.type === "error" ||
    RETRYABLE_MODEL_REQUEST_STATUSES.has(result.response.status) ||
    (result.response.status >= 500 && result.response.status <= 599)
  );
}

function modelRequestIsRateLimited(result: ModelRequestResult): boolean {
  return (
    result.type === "response" &&
    result.response.status === RATE_LIMITED_MODEL_REQUEST_STATUS
  );
}

function retryDelay(result: ModelRequestResult, fallback: number): number {
  const retryAfter =
    result.type === "response"
      ? result.response.headers.get("retry-after")
      : undefined;

  if (retryAfter === undefined || retryAfter === null) {
    return fallback;
  }

  const seconds = Number(retryAfter);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, RETRY_AFTER_MAX_MILLISECONDS)
    : fallback;
}

async function observedModelRequest(
  modelRequest: () => Promise<ModelRequestResult>,
  onResponse: ((response: Response) => void) | undefined,
): Promise<ModelRequestResult> {
  const result = await modelRequest();
  if (result.type === "response") {
    onResponse?.(result.response);
  }
  return result;
}

export async function fetchModelRequestWithRetries(
  fetch: ModelRequestFetch,
  request: Request,
  sleepFor?: ModelRequestSleep,
  onResponse?: (response: Response) => void,
): Promise<Response> {
  const wait = sleepFor ?? defaultModelRequestSleep;
  const requestModel = () => fetchModelRequest(fetch, request);
  let result = await observedModelRequest(requestModel, onResponse);
  let retryCount = 0;

  while (
    modelRequestIsRetryable(result) &&
    (retryCount < MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.length ||
      (modelRequestIsRateLimited(result) &&
        retryCount < RATE_LIMIT_RETRY_MAXIMUM_ATTEMPTS))
  ) {
    const delay =
      MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS[retryCount] ??
      MODEL_REQUEST_MAX_RETRY_DELAY_MILLISECONDS;
    await wait(retryDelay(result, delay), request.signal);
    retryCount += 1;
    result = await observedModelRequest(requestModel, onResponse);
  }

  if (result.type === "error") {
    throw result.error;
  }

  return result.response;
}
