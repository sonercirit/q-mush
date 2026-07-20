import { setTimeout as sleep } from "node:timers/promises";

const MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000] as const;
const RETRYABLE_MODEL_REQUEST_STATUSES = new Set([408, 409, 429]);
const RETRY_AFTER_MAX_MILLISECONDS = 60_000;

type ModelRequestFetch = (request: Request) => Promise<Response>;
export type ModelRequestSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

function defaultModelRequestSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return sleep(milliseconds, undefined, { signal });
}

async function fetchModelRequest(
  fetch: ModelRequestFetch,
  request: Request,
  canRetry: boolean,
): Promise<Response | undefined> {
  try {
    return await fetch(request.clone());
  } catch (error) {
    if (request.signal.aborted || !canRetry) {
      throw error;
    }

    return undefined;
  }
}

function modelRequestIsRetryable(response: Response | undefined): boolean {
  return (
    response === undefined ||
    RETRYABLE_MODEL_REQUEST_STATUSES.has(response.status) ||
    (response.status >= 500 && response.status <= 599)
  );
}

function retryDelay(response: Response | undefined, fallback: number): number {
  const retryAfter = response?.headers.get("retry-after");

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

export async function fetchModelRequestWithRetries(
  fetch: ModelRequestFetch,
  request: Request,
  sleepFor?: ModelRequestSleep,
): Promise<Response> {
  const wait = sleepFor ?? defaultModelRequestSleep;
  const requestModel = (canRetry: boolean) =>
    fetchModelRequest(fetch, request, canRetry);
  let response = await requestModel(true);

  for (const [
    index,
    delay,
  ] of MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.entries()) {
    if (!modelRequestIsRetryable(response)) {
      break;
    }

    await wait(retryDelay(response, delay), request.signal);
    response = await requestModel(
      index < MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.length - 1,
    );
  }

  if (response === undefined) {
    throw new Error("The model request failed without a response");
  }

  return response;
}
