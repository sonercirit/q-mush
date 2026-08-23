import { describe, expect, test } from "vitest";
import { resolveAnthropicModelAttempt } from "../anthropic-model-resolution.ts";
import {
  ANTHROPIC_TEST_CREDENTIAL,
  KNOWN_ANTHROPIC_MODEL,
} from "./anthropic-model-test-helpers.ts";

function detailRequest(request: Request): boolean {
  return new URL(request.url).pathname.includes("/models/");
}

function resolveWith(fetch: (request: Request) => Promise<Response>) {
  return resolveAnthropicModelAttempt({
    credential: ANTHROPIC_TEST_CREDENTIAL,
    fetch,
    model: KNOWN_ANTHROPIC_MODEL,
    provider: "generic",
  });
}

describe("Anthropic model resolution fallback boundaries", () => {
  test.each([
    ["does not crawl after a 401 detail authorization failure", 401],
    ["does not crawl after a 403 detail authorization failure", 403],
  ] as const)("%s", async (_name, status) => {
    const requests: Request[] = [];
    const result = await resolveWith((request) => {
      requests.push(request);
      return Promise.resolve(new Response(null, { status }));
    });
    expect(result).toEqual({ retryable: false });
    expect(requests).toHaveLength(1);
  });

  test("does not resolve an echoed alias absent from the model list", async () => {
    const result = await resolveWith((request) =>
      Promise.resolve(
        detailRequest(request)
          ? new Response(null, { status: 404 })
          : new Response(
              JSON.stringify({
                data: [{ id: "another-model" }],
                echoed_model: KNOWN_ANTHROPIC_MODEL,
              }),
              { headers: { "content-type": "application/json" } },
            ),
      ),
    );
    expect(result).toEqual({ retryable: false });
  });

  test.each([
    ["marks a 408 list failure retryable", 408],
    ["marks a 429 list failure retryable", 429],
    ["marks a 503 list failure retryable", 503],
  ] as const)("%s", async (_name, status) => {
    const result = await resolveWith((request) =>
      Promise.resolve(
        new Response(null, { status: detailRequest(request) ? 404 : status }),
      ),
    );
    expect(result).toEqual({ retryable: true });
  });
});
