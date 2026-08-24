import { setTimeout } from "node:timers/promises";
import { createProviderCredentialRejectionError } from "./provider-error.ts";

const MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS = [1_000, 2_000, 4_000] as const;
const MODEL_REQUEST_MAX_RETRY_DELAY_MILLISECONDS =
  MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.at(-1) ?? 4_000;
const RATE_LIMITED_MODEL_REQUEST_STATUS = 429;
const RATE_LIMIT_RETRY_MAXIMUM_ATTEMPTS = 12;
const RETRYABLE_MODEL_REQUEST_STATUSES = new Set([
  408,
  409,
  RATE_LIMITED_MODEL_REQUEST_STATUS,
]);
const RETRY_AFTER_MAX_MILLISECONDS = 60_000;

type ModelRequestFetch = (request: Request) => Promise<Response>;
export type ModelRequestSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

interface RetryableModelRequestErrorOptions {
  readonly rateLimited?: boolean;
  readonly response?: Response;
  readonly retryAfterMilliseconds?: number | undefined;
}

export interface RetryableModelRequestError extends Error {
  readonly failure: unknown;
  readonly rateLimited: boolean;
  readonly response: Response | undefined;
  readonly retryAfterMilliseconds: number | undefined;
}

const retryableModelRequestErrors = new WeakSet<object>();

export function isRetryableModelRequestError(
  error: unknown,
): error is RetryableModelRequestError {
  return error instanceof Error && retryableModelRequestErrors.has(error);
}

export const RetryableModelRequestError = Object.defineProperty(
  function RetryableModelRequestError(
    failure: unknown,
    options: RetryableModelRequestErrorOptions = {},
  ): RetryableModelRequestError {
    const error = Object.assign(
      new Error(
        failure instanceof Error
          ? failure.message
          : "The model request failed transiently",
        { cause: failure },
      ),
      {
        failure,
        name: "RetryableModelRequestError",
        rateLimited: options.rateLimited ?? false,
        response: options.response,
        retryAfterMilliseconds: options.retryAfterMilliseconds,
      },
    );
    retryableModelRequestErrors.add(error);
    return error;
  },
  Symbol.hasInstance,
  { value: isRetryableModelRequestError },
);

function defaultModelRequestSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return setTimeout(milliseconds, undefined, { signal });
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter === null) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, RETRY_AFTER_MAX_MILLISECONDS)
    : undefined;
}

function modelResponseIsRetryable(response: Response): boolean {
  return (
    RETRYABLE_MODEL_REQUEST_STATUSES.has(response.status) ||
    (response.status >= 500 && response.status <= 599)
  );
}

export function modelResponseRetryAfterMilliseconds(
  response: Response,
): number | undefined {
  return retryAfterMilliseconds(response);
}

export async function fetchModelRequestAttempt(
  fetch: ModelRequestFetch,
  request: Request,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(request.clone());
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    throw RetryableModelRequestError(error);
  }

  if (response.status === 401 || response.status === 403) {
    throw createProviderCredentialRejectionError(
      `The model credential was rejected with status ${String(response.status)}`,
      response.status,
    );
  }

  if (modelResponseIsRetryable(response)) {
    throw RetryableModelRequestError(undefined, {
      rateLimited: response.status === RATE_LIMITED_MODEL_REQUEST_STATUS,
      response,
      retryAfterMilliseconds: retryAfterMilliseconds(response),
    });
  }

  return response;
}

export async function runModelRequestWithRetries<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  sleepFor?: ModelRequestSleep,
): Promise<T> {
  const wait = sleepFor ?? defaultModelRequestSleep;

  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || !isRetryableModelRequestError(error)) {
        throw error;
      }

      const maximumRetryCount = error.rateLimited
        ? RATE_LIMIT_RETRY_MAXIMUM_ATTEMPTS
        : MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS.length;
      if (retryCount >= maximumRetryCount) {
        if (
          error.rateLimited &&
          error.response?.status === RATE_LIMITED_MODEL_REQUEST_STATUS
        ) {
          throw createProviderCredentialRejectionError(
            "The model credential was rate limited",
            RATE_LIMITED_MODEL_REQUEST_STATUS,
          );
        }
        throw error;
      }

      const delay =
        MODEL_REQUEST_RETRY_DELAYS_MILLISECONDS[retryCount] ??
        MODEL_REQUEST_MAX_RETRY_DELAY_MILLISECONDS;
      await wait(error.retryAfterMilliseconds ?? delay, signal);
    }
  }
}
