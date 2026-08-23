import { describe, expect, test } from "vitest";
import { resolveAnthropicModelAttempt } from "../anthropic-model-resolution.ts";
import {
  anthropicHarness,
  ANTHROPIC_TEST_CREDENTIAL,
  KNOWN_ANTHROPIC_MODEL,
} from "./anthropic-model-test-helpers.ts";
import { anthropicJsonResponse } from "./anthropic-response-event-fixtures.ts";

const SIGNED_TOOL_BLOCKS = [
  {
    signature: "signed-thinking",
    thinking: "Inspect.",
    type: "thinking",
  },
  {
    id: "read-call",
    input: { path: "SETUP.md" },
    name: "read",
    type: "tool_use",
  },
] as const;

describe("Anthropic model resolution", () => {
  test.each([401, 403] as const)(
    "does not crawl the model list after a %s detail authorization failure",
    async (status) => {
      const requests: Request[] = [];
      const result = await resolveAnthropicModelAttempt({
        credential: ANTHROPIC_TEST_CREDENTIAL,
        fetch: (request) => {
          requests.push(request);
          return Promise.resolve(new Response(null, { status }));
        },
        model: KNOWN_ANTHROPIC_MODEL,
        provider: "generic",
      });

      expect(result).toEqual({ retryable: false });
      expect(requests).toHaveLength(1);
    },
  );

  test("does not resolve an echoed alias that is absent from the model list", async () => {
    const result = await resolveAnthropicModelAttempt({
      credential: ANTHROPIC_TEST_CREDENTIAL,
      fetch: (request) =>
        Promise.resolve(
          new URL(request.url).pathname.endsWith(
            `/models/${KNOWN_ANTHROPIC_MODEL}`,
          )
            ? new Response(null, { status: 404 })
            : Response.json({
                data: [{ id: "another-model", type: "model" }],
                echoed_model: KNOWN_ANTHROPIC_MODEL,
                has_more: false,
              }),
        ),
      model: KNOWN_ANTHROPIC_MODEL,
      provider: "generic",
    });

    expect(result).toEqual({ retryable: false });
  });

  test.each([408, 429, 503] as const)(
    "marks a %s model-list failure retryable after detail retrieval is unsupported",
    async (status) => {
      const result = await resolveAnthropicModelAttempt({
        credential: ANTHROPIC_TEST_CREDENTIAL,
        fetch: (request) =>
          Promise.resolve(
            new URL(request.url).pathname.endsWith(
              `/models/${KNOWN_ANTHROPIC_MODEL}`,
            )
              ? new Response(null, { status: 404 })
              : new Response(null, { status }),
          ),
        model: KNOWN_ANTHROPIC_MODEL,
        provider: "generic",
      });

      expect(result).toEqual({ retryable: true });
    },
  );

  test("falls back to a generic provider's model list when retrieval is unsupported", async () => {
    const requests: Request[] = [];
    const harness = anthropicHarness([], {
      fetch: (request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "POST") {
          return Promise.resolve(
            anthropicJsonResponse({
              blocks: SIGNED_TOOL_BLOCKS,
              model: KNOWN_ANTHROPIC_MODEL,
            }),
          );
        }
        return Promise.resolve(
          url.pathname.endsWith(`/models/${KNOWN_ANTHROPIC_MODEL}`)
            ? new Response(null, { status: 404 })
            : Response.json({
                data: [{ id: KNOWN_ANTHROPIC_MODEL, type: "model" }],
                has_more: false,
              }),
        );
      },
    });

    const step = await harness.complete([{ content: "Inspect", role: "user" }]);

    expect(step.providerContinuation).toBeUndefined();
    expect(step.toolCalls).toEqual([
      {
        arguments: '{"path":"SETUP.md"}',
        id: "read-call",
        name: "read",
      },
    ]);
    expect(
      requests.map((request) => {
        const url = new URL(request.url);
        return `${request.method} ${url.pathname}${url.search}`;
      }),
    ).toEqual([
      `GET /v1/models/${KNOWN_ANTHROPIC_MODEL}`,
      "GET /v1/models?limit=1000",
      "POST /v1/messages",
    ]);
  });
});
