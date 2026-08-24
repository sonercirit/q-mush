import { describe, expect, test } from "vitest";
import { recordingSleep } from "../../shared/test/websocket-fixtures.ts";
import {
  fetchModelRequestAttempt,
  isRetryableModelRequestError,
  runModelRequestWithRetries,
  type ModelRequestSleep,
} from "../../sync-engine/agent-model-retry.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { isProviderCredentialRejection } from "../../sync-engine/provider-error.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

function unwrapResponse(error: unknown): Response {
  if (isRetryableModelRequestError(error)) {
    if (error.response !== undefined) {
      return error.response;
    }
    throw error.failure;
  }
  throw error;
}

function fetchModelRequestWithRetries(
  fetch: (request: Request) => Promise<Response>,
  request: Request,
  sleepFor?: ModelRequestSleep,
): Promise<Response> {
  return runModelRequestWithRetries(
    () => fetchModelRequestAttempt(fetch, request),
    request.signal,
    sleepFor,
  ).catch(unwrapResponse);
}

const REQUEST = new Request("https://provider.example/completions", {
  body: '{"prompt":"Hello"}',
  method: "POST",
});
function takeResponse(responses: Response[]): Response {
  const response = responses.shift();

  if (response === undefined) {
    throw new Error("The test ran out of provider responses");
  }

  return response;
}

function countedFetch(
  requestCount: { value: number },
  response: () => Promise<Response>,
) {
  return () => {
    requestCount.value += 1;
    return response();
  };
}

function fetchResponses(responses: Response[]) {
  return () => Promise.resolve(takeResponse(responses));
}

async function requestWithRecordedDelays(responses: Response[]) {
  const delays: number[] = [];
  const response = await fetchModelRequestWithRetries(
    fetchResponses(responses),
    REQUEST,
    recordingSleep(delays),
  );
  return { delays, response };
}

describe("agent model request retries", () => {
  test("retries a retryable response with an intact request body", async () => {
    const responses = [
      createJsonResponse({}, 503),
      createJsonResponse({ completion: "Recovered." }),
    ];
    const bodies: unknown[] = [];
    const delays: number[] = [];
    const response = await fetchModelRequestWithRetries(
      async (request) => {
        bodies.push(await request.json());
        return takeResponse(responses);
      },
      REQUEST,
      recordingSleep(delays),
    );

    expect(await response.json()).toEqual({ completion: "Recovered." });
    expect(bodies).toEqual([{ prompt: "Hello" }, { prompt: "Hello" }]);
    expect(delays).toEqual([1_000]);
  });

  test("retries a rejected provider request", async () => {
    const requestCount = { value: 0 };
    const delays: number[] = [];
    const response = await fetchModelRequestWithRetries(
      countedFetch(requestCount, () =>
        requestCount.value === 1
          ? Promise.reject(new TypeError("Connection reset"))
          : Promise.resolve(createJsonResponse({ completion: "Recovered." })),
      ),
      REQUEST,
      recordingSleep(delays),
    );

    expect(response.ok).toBe(true);
    expect(requestCount.value).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  test("uses exponential backoff and returns the last response", async () => {
    const responses = [408, 409, 429, 504].map((status) =>
      createJsonResponse({ status }, status),
    );
    const { delays, response } = await requestWithRecordedDelays(responses);

    expect(response.status).toBe(504);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  test("honors a Retry-After delay", async () => {
    const responses = [
      new Response(null, { headers: { "retry-after": "3" }, status: 429 }),
      createJsonResponse({}),
    ];
    const { delays, response } = await requestWithRecordedDelays(responses);

    expect(response.ok).toBe(true);
    expect(delays).toEqual([3_000]);
  });

  test("keeps retrying a rate-limited request until it succeeds", async () => {
    const responses = Array.from(
      { length: 4 },
      () => new Response(null, { status: 429 }),
    );
    responses.push(createJsonResponse({ completion: "Accepted." }));
    const result = await requestWithRecordedDelays(responses);

    expect(await result.response.json()).toEqual({ completion: "Accepted." });
    expect(result.delays.join(",")).toBe("1000,2000,4000,4000");
  });

  test("classifies authentication and exhausted rate limits as credential rejections", async () => {
    await expect(
      runModelRequestWithRetries(
        () =>
          fetchModelRequestAttempt(
            fetchResponses([new Response(null, { status: 401 })]),
            REQUEST,
          ),
        REQUEST.signal,
      ),
    ).rejects.toMatchObject({ status: 401 });

    let attempts = 0;
    await expect(
      runModelRequestWithRetries(
        () => {
          attempts += 1;
          return fetchModelRequestAttempt(
            () => Promise.resolve(new Response(null, { status: 429 })),
            REQUEST,
          );
        },
        REQUEST.signal,
        () => Promise.resolve(),
      ),
    ).rejects.toSatisfy(isProviderCredentialRejection);
    expect(attempts).toBe(13);
  });

  test("does not retry a non-retryable response", async () => {
    const requestCount = { value: 0 };
    const response = await fetchModelRequestWithRetries(
      countedFetch(requestCount, () =>
        Promise.resolve(createJsonResponse({}, 400)),
      ),
      REQUEST,
      () => {
        throw new Error("A non-retryable response must not be delayed");
      },
    );

    expect(response.status).toBe(400);
    expect(requestCount.value).toBe(1);
  });

  test("does not retry a redirect response", async () => {
    let requestCount = 0;
    const response = await fetchModelRequestWithRetries(
      () => {
        requestCount += 1;
        return Promise.resolve(new Response(null, { status: 307 }));
      },
      REQUEST,
      () => {
        throw new Error("A redirect response must not be delayed");
      },
    );

    expect(response.status).toBe(307);
    expect(requestCount).toBe(1);
  });

  test("aborts during backoff", async () => {
    const controller = new AbortController();
    const request = new Request(REQUEST, { signal: controller.signal });
    const requestCount = { value: 0 };
    const error = await captureRejection(
      fetchModelRequestWithRetries(
        countedFetch(requestCount, () =>
          Promise.resolve(createJsonResponse({}, 503)),
        ),
        request,
        (_milliseconds, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          return Promise.reject(new DOMException("Stopped", "AbortError"));
        },
      ),
    );

    expect(error).toMatchObject({ name: "AbortError" });
    expect(requestCount.value).toBe(1);
  });

  test("preserves the final network error after all attempts fail", async () => {
    const requestCount = { value: 0 };
    const rejectedRequest = fetchModelRequestWithRetries(
      countedFetch(requestCount, () =>
        Promise.reject(new TypeError("Sensitive network detail")),
      ),
      REQUEST,
      () => Promise.resolve(),
    );
    const error = await captureRejection(rejectedRequest);

    expect(requestCount.value).toBe(4);
    expect(requireError(error).message).toBe("Sensitive network detail");
  });
});
