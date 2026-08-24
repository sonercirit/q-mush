import { describe, expect, test } from "vitest";
import { discoverOpenRouterProviders } from "../../sync-engine/openrouter-provider-discovery.ts";
import {
  abortAndObserveCanceledReader,
  neverReadingResponse,
  stalledResponseReaderFixture,
} from "./discovery-cancellation-fixtures.ts";
import {
  discoverWithResponse,
  endpoint,
  endpointResponse,
  openRouterCredential,
} from "./openrouter-provider-discovery-helpers.ts";

function invoke(
  discover = discoverWithResponse(
    endpointResponse([endpoint("openai", "OpenAI")]),
  ),
  model = "vendor/model",
) {
  return discover("owner-1", openRouterCredential(), model);
}

const PRICING = {
  cachedInput: "0.0000001",
  input: "0.0000004",
  output: "0.0000016",
};

function expectedProvider(tag: string, name: string, contextWindow = 131_072) {
  return { contextWindow, name, pricing: PRICING, tag };
}

async function expectTimeout(discover: Parameters<typeof invoke>[0]) {
  await expect(invoke(discover)).rejects.toMatchObject({
    name: "TimeoutError",
  });
}

function stalledFetch() {
  return new Promise<Response>(() => undefined);
}

describe("OpenRouter serving-provider discovery", () => {
  test("uses authoritative endpoint tags and bounded metadata", async () => {
    const requests: Request[] = [];
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve(
          endpointResponse([
            endpoint("together", "Together", { context_length: 64_000 }),
            endpoint("google-vertex/us", "Google Vertex"),
            endpoint("openai", "OpenAI"),
            endpoint("openai", "Duplicate", { context_length: 1 }),
            endpoint("offline", "Offline", { status: -1 }),
            endpoint("bad tag!", "Malformed"),
          ]),
        );
      },
    });

    await expect(
      discover(
        "owner-1",
        openRouterCredential(),
        "anthropic/claude-3.5-sonnet:beta",
      ),
    ).resolves.toEqual({
      providers: [
        expectedProvider("google-vertex/us", "Google Vertex"),
        expectedProvider("openai", "OpenAI"),
        expectedProvider("together", "Together", 64_000),
      ],
    });
    expect(requests[0]?.url).toBe(
      "https://openrouter.ai/api/v1/models/anthropic/claude-3.5-sonnet%3Abeta/endpoints",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer secret-credential-1",
    );
    expect(requests[0]?.headers.has("content-type")).toBe(false);
  });

  test("rejects malformed models without requesting upstream", async () => {
    let requests = 0;
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: () => {
        requests += 1;
        return Promise.resolve(endpointResponse([]));
      },
    });

    for (const model of ["missing-author", "vendor/model/extra", "../bad"]) {
      await expect(invoke(discover, model)).rejects.toThrow(
        "model identifier is invalid",
      );
    }
    expect(requests).toBe(0);
  });

  test("classifies credential rejection responses", async () => {
    for (const status of [401, 402, 403, 429] as const) {
      await expect(
        invoke(discoverWithResponse(new Response(null, { status }))),
      ).rejects.toEqual(
        expect.objectContaining({
          kind: "provider_credential_rejection",
          status,
        }),
      );
    }
  });

  test("bounds response bytes and endpoint count", async () => {
    await expect(
      invoke(
        discoverWithResponse(
          new Response("{}", {
            headers: { "content-length": String(2 * 1024 * 1024) },
          }),
        ),
      ),
    ).rejects.toThrow("response was too large");

    await expect(
      invoke(discoverWithResponse(new Response("x".repeat(2 * 1024 * 1024)))),
    ).rejects.toThrow("response was too large");

    await expect(
      invoke(
        discoverWithResponse(
          endpointResponse(
            Array.from({ length: 201 }, (_, index) =>
              endpoint(
                `provider-${String(index)}`,
                `Provider ${String(index)}`,
              ),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("too many serving providers");
  });

  test("times out stalled fetches independently of fetch signal handling", async () => {
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: stalledFetch,
      timeoutMilliseconds: 5,
    });

    await expectTimeout(discover);
  });

  test("supports caller cancellation", async () => {
    const controller = new AbortController();

    const discover = discoverOpenRouterProviders.withOptions({
      fetch: stalledFetch,
    });
    const pending = discover(
      "owner-1",
      openRouterCredential(),
      "vendor/model",
      { signal: controller.signal },
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("releases stalled body cleanup after abort settlement", async () => {
    const fixture = stalledResponseReaderFixture();
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: () => Promise.resolve(fixture.response),
    });
    const { captured, controller } = fixture.start((_response, signal) =>
      discover("owner-1", openRouterCredential(), "vendor/model", { signal }),
    );

    await abortAndObserveCanceledReader(fixture, captured, controller);
  });

  test("preserves timeout errors from stalled response bodies", async () => {
    const discover = discoverOpenRouterProviders.withOptions({
      fetch: () => Promise.resolve(neverReadingResponse()),
      timeoutMilliseconds: 5,
    });

    await expectTimeout(discover);
  });

  test("isolates and bounds the owner, credential, and model cache", async () => {
    let calls = 0;
    let now = 1_000;
    const discover = discoverOpenRouterProviders.withOptions({
      cacheTtlMilliseconds: 100,
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          endpointResponse([endpoint("openai", "OpenAI")]),
        );
      },
      maximumCacheEntries: 2,
      now: () => now,
    });
    const credential = openRouterCredential();

    await discover("owner-1", credential, "vendor/one");
    await discover("owner-1", credential, "vendor/one");
    await discover("owner-2", credential, "vendor/one");
    expect(calls).toBe(2);

    await discover(
      "owner-1",
      openRouterCredential("credential-2"),
      "vendor/one",
    );
    await discover("owner-2", credential, "vendor/one");
    expect(calls).toBe(3);

    await discover("owner-1", credential, "vendor/one");
    expect(calls).toBe(4);
    now += 101;
    await discover("owner-1", credential, "vendor/one");
    await discover("owner-1", credential, "vendor/one", { force: true });
    expect(calls).toBe(6);
  });
});
