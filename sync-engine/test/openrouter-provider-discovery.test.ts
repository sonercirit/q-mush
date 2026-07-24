import { describe, expect, test } from "vitest";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { discoverOpenRouterProviders } from "../../sync-engine/openrouter-provider-discovery.ts";
import {
  discoverWithResponse,
  invokeDiscovery,
  openRouterCredential,
  providerOption,
} from "./openrouter-provider-discovery-helpers.ts";
import { captureRejection, requireError } from "./promise-test-helpers.ts";

function endpoint(
  tag: string,
  providerName: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    context_length: 131_072,
    name: `${providerName}: model`,
    pricing: {
      completion: "0.0000016",
      input_cache_read: "0.0000001",
      prompt: "0.0000004",
    },
    provider_name: providerName,
    status: 0,
    supported_parameters: ["tools", "temperature"],
    tag,
    uptime_last_30m: 99.9,
    ...overrides,
  };
}

function response(endpoints: readonly unknown[]): Response {
  return createJsonResponse({
    data: {
      architecture: {},
      created: 1,
      description: "Model",
      endpoints,
      id: "anthropic/claude-3.5-sonnet:beta",
      name: "Claude",
    },
  });
}

function captureFetch(result: Response, requests: Request[]) {
  return (request: Request) => {
    requests.push(request);
    return Promise.resolve(result.clone());
  };
}

function assertRequestCount(
  counter: { readonly value: number },
  expected: number,
): void {
  expect(counter.value).toBe(expected);
}

function countedProviderFetch(counter: { value: number }) {
  return () => {
    counter.value += 1;
    return Promise.resolve(response([endpoint("openai", "OpenAI")]));
  };
}

async function timeoutError(
  fetch: (request: Request) => Promise<Response>,
): Promise<Error> {
  const discover = discoverOpenRouterProviders.withOptions({
    fetch,
    timeoutMilliseconds: 5,
  });
  return requireError(await captureRejection(invokeDiscovery(discover)));
}

describe("OpenRouter serving-provider discovery", () => {
  test("discovers bounded model endpoints using authoritative tags and metadata", async () => {
    const requests: Request[] = [];
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: captureFetch(
        response([
          endpoint("together", "Together", { context_length: 64_000 }),
          endpoint("google-vertex/us", "Google Vertex"),
          endpoint("openai", "OpenAI"),
          endpoint("openai", "Duplicate OpenAI", { context_length: 32_000 }),
          endpoint("offline", "Offline", { status: -1 }),
          endpoint("bad tag!", "Malformed"),
          { provider_name: "Missing tag" },
        ]),
        requests,
      ),
    });

    const catalog = await discover(
      "owner-1",
      openRouterCredential("credential-1", "sk-or-secret"),
      "anthropic/claude-3.5-sonnet:beta",
    );

    const sharedPricing = providerOption("ignored", "ignored").pricing;
    expect(catalog).toEqual({
      providers: [
        {
          contextWindow: 131_072,
          name: "Google Vertex",
          pricing: sharedPricing,
          tag: "google-vertex/us",
        },
        {
          contextWindow: 131_072,
          name: "OpenAI",
          pricing: sharedPricing,
          tag: "openai",
        },
        {
          contextWindow: 64_000,
          name: "Together",
          pricing: sharedPricing,
          tag: "together",
        },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://openrouter.ai/api/v1/models/anthropic/claude-3.5-sonnet%3Abeta/endpoints",
    );
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer sk-or-secret",
    );
    expect(requests[0]?.headers.has("content-type")).toBe(false);
  });

  test("handles missing endpoint metadata without retaining invalid values", async () => {
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: () =>
        Promise.resolve(
          response([
            endpoint("minimal", " Minimal provider ", {
              context_length: Number.MAX_SAFE_INTEGER,
              pricing: {
                completion: "not-a-price",
                prompt: "0.000001",
              },
            }),
          ]),
        ),
    });

    await expect(
      discover("owner-1", openRouterCredential("credential-1"), "vendor/model"),
    ).resolves.toEqual({
      providers: [
        {
          contextWindow: null,
          name: "Minimal provider",
          pricing: null,
          tag: "minimal",
        },
      ],
    });
  });

  test("rejects malformed model paths before making an upstream request", async () => {
    let requests = 0;
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: () => {
        requests += 1;
        return Promise.resolve(response([]));
      },
    });

    for (const model of [
      "missing-author",
      "vendor/model/extra",
      "../vendor/model",
      `vendor/${"x".repeat(201)}`,
    ]) {
      await expect(
        discover("owner-1", openRouterCredential("credential-1"), model),
      ).rejects.toThrow("model identifier is invalid");
    }
    expect(requests).toBe(0);
  });

  test("bounds response bytes and endpoint count", async () => {
    const tooLargeByHeader = discoverWithResponse(
      new Response("{}", {
        headers: { "content-length": String(2 * 1024 * 1024) },
      }),
    );
    await expect(invokeDiscovery(tooLargeByHeader)).rejects.toThrow(
      "response was too large",
    );

    const tooLargeBody = discoverWithResponse(
      new Response("x".repeat(2 * 1024 * 1024)),
    );
    await expect(invokeDiscovery(tooLargeBody)).rejects.toThrow(
      "response was too large",
    );

    const tooMany = discoverOpenRouterProviders.withOptions({
      fetch: () =>
        Promise.resolve(
          response(
            Array.from({ length: 201 }, (_, index) =>
              endpoint(
                `provider-${String(index)}`,
                `Provider ${String(index)}`,
              ),
            ),
          ),
        ),
    });
    await expect(
      tooMany("owner", openRouterCredential("credential"), "vendor/model"),
    ).rejects.toThrow("too many serving providers");
  });

  test("rejects invalid JSON and unsuccessful responses with bounded errors", async () => {
    const invalidJson = discoverOpenRouterProviders.withOptions({
      fetch: () => Promise.resolve(new Response("not-json")),
    });
    await expect(
      invalidJson("owner", openRouterCredential("credential"), "vendor/model"),
    ).rejects.toThrow("invalid endpoint JSON");

    const unavailable = discoverOpenRouterProviders.withOptions({
      fetch: () =>
        Promise.resolve(new Response("secret upstream body", { status: 503 })),
    });
    await expect(
      unavailable("owner", openRouterCredential("credential"), "vendor/model"),
    ).rejects.toThrow("status 503");
  });

  test("enforces its timeout even when the fetch implementation stalls", async () => {
    const error = await timeoutError(() => new Promise(() => undefined));

    expect(error.name).toBe("TimeoutError");
  });

  test("times out while an upstream response body stalls", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([123]));
        return new Promise(() => undefined);
      },
    });
    const error = await timeoutError((request) => {
      request.signal.addEventListener("abort", () => undefined, { once: true });
      return Promise.resolve(new Response(stream));
    });

    expect(error.name).toBe("TimeoutError");
  });

  test("honors an external abort signal", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: (request) => {
        upstreamSignal = request.signal;
        return new Promise(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = discover(
      "owner",
      openRouterCredential("credential"),
      "vendor/model",
      { signal: controller.signal },
    );
    controller.abort();
    const error = await captureRejection(pending);

    expect(requireError(error).name).toBe("AbortError");
    expect(upstreamSignal?.aborted).toBe(true);
  });

  test("bounds cache entries and evicts the oldest successful result", async () => {
    const requestCount = { value: 0 };
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: countedProviderFetch(requestCount),
      maximumCacheEntries: 2,
    });
    const key = openRouterCredential("credential");

    await discover("owner", key, "vendor/first");
    await discover("owner", key, "vendor/second");
    await discover("owner", key, "vendor/third");
    await discover("owner", key, "vendor/second");
    assertRequestCount(requestCount, 3);

    await discover("owner", key, "vendor/first");
    assertRequestCount(requestCount, 4);
  });

  test("uses a short-lived cache isolated by owner, credential, and model", async () => {
    let now = 1_000;
    const requestCount = { value: 0 };
    const discover = discoverOpenRouterProviders.withOptions({
      cacheTtlMilliseconds: 100,
      fetch: countedProviderFetch(requestCount),
      now: () => now,
    });
    const firstCredential = openRouterCredential("credential-1");

    await discover("owner-1", firstCredential, "vendor/model");
    await discover("owner-1", firstCredential, "vendor/model");
    assertRequestCount(requestCount, 1);

    await discover("owner-2", firstCredential, "vendor/model");
    await discover(
      "owner-1",
      openRouterCredential("credential-2"),
      "vendor/model",
    );
    await discover("owner-1", firstCredential, "vendor/other-model");
    assertRequestCount(requestCount, 4);

    now += 101;
    await discover("owner-1", firstCredential, "vendor/model");
    assertRequestCount(requestCount, 5);

    await discover("owner-1", firstCredential, "vendor/model", {
      force: true,
    });
    assertRequestCount(requestCount, 6);
  });
});
