import { expect, test } from "vitest";
import type {
  AgentModelCatalog,
  AgentModelOption,
} from "../../shared/agent-configuration.ts";
import { discoverAgentModels } from "../../sync-engine/agent-model-discovery.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import {
  anthropicFormatCredential,
  catalog,
  model,
} from "./agent-model-discovery-helpers.ts";

function capabilityListing(
  capabilities: Readonly<Record<string, unknown>>,
  id: string,
  displayName: string,
  extra?: Readonly<Record<string, unknown>>,
): unknown {
  return { capabilities, display_name: displayName, id, ...extra };
}

function expectSoleModel(
  discovered: AgentModelCatalog,
  expected: AgentModelOption,
): void {
  expect(discovered).toEqual(catalog(expected.id, [expected]));
}

async function discoverAnthropicFormat(
  respond: (request: Request) => Response,
): Promise<{
  readonly discovered: AgentModelCatalog;
  readonly requests: Request[];
}> {
  const requests: Request[] = [];
  const discovered = await discoverAgentModels(
    "generic",
    anthropicFormatCredential(),
    (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
  );
  return { discovered, requests };
}

// Anthropic-format requests carry x-api-key; the OpenAI-style effort probe
// hits the same base URL with a bearer header instead.
function dualListing(
  anthropicModels: readonly unknown[],
  openAiModels: readonly unknown[],
): (request: Request) => Response {
  return (request) =>
    request.headers.has("x-api-key")
      ? createJsonResponse({ data: anthropicModels, has_more: false })
      : createJsonResponse({ data: openAiModels });
}

test("discovers Anthropic-format models and merges OpenAI-listed efforts", async () => {
  const { discovered, requests } = await discoverAnthropicFormat(
    dualListing(
      [
        {
          created_at: "2026-01-01T00:00:00Z",
          display_name: "Claude Test 4",
          id: "claude-test-4",
          max_input_tokens: 200_000,
          type: "model",
        },
      ],
      [
        {
          id: "claude-test-4",
          supported_reasoning_efforts: ["none", "low", "high", "max"],
        },
      ],
    ),
  );

  expectSoleModel(
    discovered,
    model(
      "claude-test-4",
      "Claude Test 4",
      ["none", "low", "high", "max"],
      200_000,
    ),
  );
  expect(requests).toHaveLength(2);
  const [primary, secondary] = requests;
  expect(primary?.url).toBe(
    "https://anthropic.example.test/v1/models?limit=1000",
  );
  expect(primary?.headers.get("x-api-key")).toBe("anthropic-secret");
  expect(primary?.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(primary?.headers.has("authorization")).toBe(false);
  expect(secondary?.url).toBe("https://anthropic.example.test/v1/models");
  expect(secondary?.headers.get("authorization")).toBe(
    "Bearer anthropic-secret",
  );
  expect(secondary?.headers.has("x-api-key")).toBe(false);
});

test("reads Anthropic capability efforts and modalities without a second probe", async () => {
  const { discovered, requests } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing(
          {
            effort: {
              high: { supported: true },
              low: { supported: true },
              max: { supported: true },
              medium: { supported: true },
              // A hypothetical "none" leaf must not duplicate the level
              // the catalog always prepends.
              none: { supported: true },
              supported: true,
              xhigh: { supported: false },
            },
            image_input: { supported: true },
            pdf_input: { supported: true },
            thinking: {
              supported: true,
              types: { adaptive: { supported: true } },
            },
          },
          "claude-caps-5",
          "Claude Caps 5",
          { max_input_tokens: 1_000_000, type: "model" },
        ),
      ],
      [],
    ),
  );

  expectSoleModel(
    discovered,
    model(
      "claude-caps-5",
      "Claude Caps 5",
      ["none", "low", "medium", "high", "max"],
      1_000_000,
      ["text", "image", "pdf"],
    ),
  );
  // Capability metadata answered efforts, so no OpenAI-style probe runs.
  expect(requests).toHaveLength(1);
});

test("keeps generic modalities when capabilities lack modality leaves", async () => {
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing(
          { context_window: 128_000 },
          "claude-proxy-1",
          "Claude Proxy 1",
          { input_modalities: ["text", "image"] },
        ),
      ],
      [],
    ),
  );

  expectSoleModel(
    discovered,
    model("claude-proxy-1", "Claude Proxy 1", [], 128_000, ["text", "image"]),
  );
});

test("follows Anthropic has_more cursors across pages", async () => {
  const paginated = await discoverAnthropicFormat((request) => {
    if (!request.headers.has("x-api-key")) {
      return createJsonResponse({ data: [] });
    }
    const paged = new URL(request.url).searchParams.has("after_id");
    return createJsonResponse({
      data: [
        {
          display_name: paged ? "Claude Page 2" : "Claude Page 1",
          id: paged ? "claude-page-2" : "claude-page-1",
        },
      ],
      has_more: !paged,
      last_id: paged ? "claude-page-2" : "claude-page-1",
    });
  });

  expect(paginated.discovered.models.map(({ id }) => id)).toEqual([
    "claude-page-1",
    "claude-page-2",
  ]);
  expect(paginated.requests[0]?.url).toContain("limit=1000");
  expect(paginated.requests[1]?.url).toContain("after_id=claude-page-1");
});

test("keeps authoritative Anthropic effort metadata over the OpenAI listing", async () => {
  const anthropicListing = [
    capabilityListing(
      {
        effort: {
          high: { supported: true },
          supported: true,
        },
        thinking: { types: { adaptive: { supported: false } } },
      },
      "claude-gated-1",
      "Claude Gated 1",
    ),
    capabilityListing(
      { effort: { supported: false } },
      "claude-off-1",
      "Claude Off 1",
    ),
    // Named levels but no adaptive leaf anywhere: efforts imply sending
    // adaptive thinking, which is unverifiable here, so authoritative.
    // With the boolean-shorthand adaptive leaf, support is confirmed.
    ...[
      { id: "claude-bare-1", label: "Claude Bare 1", thinking: undefined },
      {
        id: "claude-short-1",
        label: "Claude Short 1",
        thinking: { types: { adaptive: true } },
      },
    ].map(({ id, label, thinking }) =>
      capabilityListing(
        {
          effort: { low: { supported: true }, supported: true },
          ...(thinking === undefined ? {} : { thinking }),
        },
        id,
        label,
      ),
    ),
    { display_name: "Claude Unknown 1", id: "claude-unknown-1" },
  ];
  const openAiListing = [
    { id: "claude-gated-1", supported_reasoning_efforts: ["low"] },
    { id: "claude-off-1", supported_reasoning_efforts: ["low"] },
    { id: "claude-bare-1", supported_reasoning_efforts: ["low"] },
    {
      id: "claude-unknown-1",
      supported_reasoning_efforts: ["low", "high"],
    },
  ];
  const { discovered, requests } = await discoverAnthropicFormat(
    dualListing(anthropicListing, openAiListing),
  );

  // Adaptive-incapable and explicitly unsupported models keep their
  // authoritative empty efforts; only the metadata-free model accepts the
  // OpenAI-style listing.
  expect(
    discovered.models.map(({ id, reasoningEfforts }) => [id, reasoningEfforts]),
  ).toEqual([
    ["claude-gated-1", []],
    ["claude-off-1", []],
    ["claude-bare-1", []],
    ["claude-short-1", ["none", "low"]],
    ["claude-unknown-1", ["low", "high"]],
  ]);
  expect(requests).toHaveLength(2);
});

test("an adaptive-incapable model without effort metadata stays effortless", async () => {
  // Full leaf, partial-tree denial, and boolean shorthand all count.
  for (const thinking of [
    { types: { adaptive: { supported: false } } },
    { supported: false },
    { types: { adaptive: false } },
  ]) {
    const { discovered } = await discoverAnthropicFormat(
      dualListing(
        [capabilityListing({ thinking }, "claude-manual-1", "Claude Manual 1")],
        [
          {
            id: "claude-manual-1",
            supported_reasoning_efforts: ["low", "high"],
          },
        ],
      ),
    );

    // The explicit non-support is authoritative even though the capability
    // tree carries no effort node: the OpenAI-style listing must not
    // enable efforts that would send a rejected adaptive thinking type.
    expectSoleModel(
      discovered,
      model("claude-manual-1", "Claude Manual 1", []),
    );
  }
});

test("affirmed effort support without named levels accepts listed efforts", async () => {
  const levelless = {
    effort: { supported: true },
    thinking: { types: { adaptive: { supported: true } } },
  };
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [capabilityListing(levelless, "claude-terse-1", "Claude Terse 1")],
      [{ id: "claude-terse-1", supported_reasoning_efforts: ["low", "max"] }],
    ),
  );

  // Support without levels reads as unknown, not none — and adaptive is
  // confirmed, so levels from the OpenAI-style listing are safe to offer.
  expectSoleModel(
    discovered,
    model("claude-terse-1", "Claude Terse 1", ["low", "max"]),
  );
});

test("a metadata-free duplicate cannot reopen an authoritative model", async () => {
  const effortless = { effort: { supported: false } };
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing(effortless, "claude-dup-1", "Claude Dup 1"),
        { display_name: "Claude Dup 1 Again", id: "claude-dup-1" },
      ],
      [{ id: "claude-dup-1", supported_reasoning_efforts: ["low"] }],
    ),
  );

  // The catalog keeps the first (authoritative) occurrence, so the later
  // metadata-free duplicate must not mark the ID for the fallback merge.
  expectSoleModel(discovered, model("claude-dup-1", "Claude Dup 1", []));
});

test("fails discovery when a has_more page lacks a fresh cursor", async () => {
  const expectInconsistentPage = (
    page: Readonly<Record<string, unknown>>,
  ): Promise<void> =>
    expect(
      discoverAnthropicFormat(() => createJsonResponse(page)),
    ).rejects.toThrow("inconsistent model catalog page");
  const item = { display_name: "Claude Trunc 1", id: "claude-trunc-1" };

  await expectInconsistentPage({ data: [item], has_more: true });
  await expectInconsistentPage({ data: [item], has_more: true, last_id: "" });
  await expectInconsistentPage({ data: [], has_more: true, last_id: "fresh" });
  // A repeating cursor would refetch the same page forever.
  await expectInconsistentPage({
    data: [item],
    has_more: true,
    last_id: "claude-trunc-1",
  });

  // Distinct cursors over near-empty pages stop at the page cap instead
  // of stretching discovery into thousands of requests; the pages were
  // well-formed, so the failure reports catalog size rather than shape.
  let page = 0;
  await expect(
    discoverAnthropicFormat(() => {
      page += 1;
      return createJsonResponse({
        data: [{ id: `claude-crawl-${String(page)}` }],
        has_more: true,
        last_id: `cursor-${String(page)}`,
      });
    }),
  ).rejects.toThrow("too many options");
  expect(page).toBe(500);
});

test("keeps the Anthropic-format catalog when no OpenAI listing exists", async () => {
  const { discovered } = await discoverAnthropicFormat((request) =>
    request.headers.has("x-api-key")
      ? createJsonResponse({
          data: [{ display_name: "Claude Plain 1", id: "claude-plain-1" }],
        })
      : new Response("denied", { status: 404 }),
  );

  expectSoleModel(discovered, model("claude-plain-1", "Claude Plain 1", []));
});
