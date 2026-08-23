import { describe, expect, test } from "vitest";
import {
  anthropicHarness,
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
