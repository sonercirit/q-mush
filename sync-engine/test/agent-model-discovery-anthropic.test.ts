import { expect, test } from "vitest";
import type {
  AgentModelCatalog,
  AgentModelOption,
  AgentReasoningEffort,
} from "../../shared/agent-configuration.ts";
import { discoverAgentModelsWithFetch } from "../../sync-engine/agent-model-discovery.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import {
  anthropicFormatCredential,
  catalog,
  model,
} from "./agent-model-discovery-helpers.ts";

interface CapabilityListingOptions {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly displayName: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly id: string;
}

function capabilityListing({
  capabilities,
  displayName,
  extra = {},
  id,
}: CapabilityListingOptions): unknown {
  return { capabilities, display_name: displayName, id, ...extra };
}

function expectedCapabilityModel(
  id: string,
  label: string,
  reasoningEfforts: readonly AgentReasoningEffort[],
  adaptiveThinking: boolean | null,
): AgentModelOption {
  return { ...model(id, label, reasoningEfforts), adaptiveThinking };
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
  const discovered = await discoverAgentModelsWithFetch(
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

function singleCapabilityListing(
  listing: CapabilityListingOptions,
  openAiModel: Readonly<Record<string, unknown>>,
): (request: Request) => Response {
  return dualListing([capabilityListing(listing)], [openAiModel]);
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
          max_tokens: 64_000,
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
      null,
      null,
      null,
      64_000,
    ),
  );
  expect(requests).toHaveLength(2);
  const [primary, secondary] = requests;
  expect(primary?.url).toBe(
    "https://anthropic.example.test/v1/models?limit=1000",
  );
  expect(primary?.headers.get("x-api-key")).toBe("anthropic-secret");
  expect(primary?.headers.get("anthropic-version")).toBe("2023-06-01");
  // Discovery must stay reachable everywhere: no beta names on catalogs.
  expect(primary?.headers.has("anthropic-beta")).toBe(false);
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
        capabilityListing({
          capabilities: {
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
          displayName: "Claude Caps 5",
          extra: { max_input_tokens: 1_000_000, type: "model" },
          id: "claude-caps-5",
        }),
      ],
      [],
    ),
  );

  expectSoleModel(discovered, {
    ...model(
      "claude-caps-5",
      "Claude Caps 5",
      ["none", "low", "medium", "high", "max"],
      1_000_000,
      ["text", "image", "pdf"],
    ),
    adaptiveThinking: true,
  });
  // Capability metadata answered efforts, so no OpenAI-style probe runs.
  expect(requests).toHaveLength(1);
});

test("keeps generic modalities when capabilities lack modality leaves", async () => {
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing({
          capabilities: { context_window: 128_000 },
          displayName: "Claude Proxy 1",
          extra: { input_modalities: ["text", "image"] },
          id: "claude-proxy-1",
        }),
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
    capabilityListing({
      capabilities: {
        effort: {
          high: { supported: true },
          supported: true,
        },
        thinking: { types: { adaptive: { supported: false } } },
      },
      displayName: "Claude Gated 1",
      id: "claude-gated-1",
    }),
    capabilityListing({
      capabilities: { effort: { supported: false } },
      displayName: "Claude Off 1",
      id: "claude-off-1",
    }),
    // Named levels do not depend on adaptive thinking. The separate
    // capability is persisted so requests can omit a rejected thinking type.
    ...[
      { id: "claude-bare-1", label: "Claude Bare 1", thinking: undefined },
      {
        id: "claude-short-1",
        label: "Claude Short 1",
        thinking: { types: { adaptive: true } },
      },
    ].map(({ id, label, thinking }) =>
      capabilityListing({
        capabilities: {
          effort: { low: { supported: true }, supported: true },
          ...(thinking === undefined ? {} : { thinking }),
        },
        displayName: label,
        id,
      }),
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

  // Adaptive-incapable models retain their effort levels; only explicitly
  // unsupported effort is authoritative empty, and metadata-free models use
  // the OpenAI-style listing.
  expect(
    discovered.models.map(({ adaptiveThinking, id, reasoningEfforts }) => [
      id,
      reasoningEfforts,
      adaptiveThinking,
    ]),
  ).toEqual([
    ["claude-gated-1", ["none", "high"], false],
    ["claude-off-1", [], null],
    ["claude-bare-1", ["none", "low"], null],
    ["claude-short-1", ["none", "low"], true],
    ["claude-unknown-1", ["low", "high"], null],
  ]);
  expect(requests).toHaveLength(2);
});

test("an adaptive-incapable model without effort metadata keeps effort unknown", async () => {
  // Full leaf, partial-tree denial, and boolean shorthand all count.
  for (const thinking of [
    { types: { adaptive: { supported: false } } },
    { supported: false },
    { types: { adaptive: false } },
  ]) {
    const { discovered } = await discoverAnthropicFormat(
      singleCapabilityListing(
        {
          capabilities: { thinking },
          displayName: "Claude Manual 1",
          id: "claude-manual-1",
        },
        {
          id: "claude-manual-1",
          supported_reasoning_efforts: ["low", "high"],
        },
      ),
    );

    // Adaptive non-support must not invent effort non-support. The fallback
    // listing can provide levels, while the request path still omits adaptive
    // thinking for this model.
    expectSoleModel(
      discovered,
      expectedCapabilityModel(
        "claude-manual-1",
        "Claude Manual 1",
        ["low", "high"],
        false,
      ),
    );
  }
});

test("preserves unknown adaptive metadata when a leaf has no support flag", async () => {
  const { discovered } = await discoverAnthropicFormat(
    singleCapabilityListing(
      {
        capabilities: { thinking: { types: { adaptive: {} } } },
        displayName: "Claude Unknown Adaptive 1",
        id: "claude-unknown-adaptive-1",
      },
      {
        id: "claude-unknown-adaptive-1",
        supported_reasoning_efforts: ["low"],
      },
    ),
  );

  expectSoleModel(
    discovered,
    expectedCapabilityModel(
      "claude-unknown-adaptive-1",
      "Claude Unknown Adaptive 1",
      ["low"],
      null,
    ),
  );
});

test("affirmed effort support without named levels accepts listed efforts", async () => {
  const levelless = {
    effort: { supported: true },
    thinking: { types: { adaptive: { supported: true } } },
  };
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing({
          capabilities: levelless,
          displayName: "Claude Terse 1",
          id: "claude-terse-1",
        }),
      ],
      [{ id: "claude-terse-1", supported_reasoning_efforts: ["low", "max"] }],
    ),
  );

  // Support without levels reads as unknown, not none; listed levels are
  // safe to offer and adaptive support remains attached to the option.
  expectSoleModel(
    discovered,
    expectedCapabilityModel(
      "claude-terse-1",
      "Claude Terse 1",
      ["low", "max"],
      true,
    ),
  );
});

test("a metadata-free duplicate cannot reopen an authoritative model", async () => {
  const effortless = { effort: { supported: false } };
  const { discovered } = await discoverAnthropicFormat(
    dualListing(
      [
        capabilityListing({
          capabilities: effortless,
          displayName: "Claude Dup 1",
          id: "claude-dup-1",
        }),
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

test("propagates an abort raised during the OpenAI-style effort probe", async () => {
  const controller = new AbortController();
  const reason = new DOMException("The operation was aborted", "AbortError");

  // The Anthropic page succeeds; the caller's deadline fires before the
  // best-effort second probe. A canceled discovery must reject instead of
  // resolving successfully with the partial catalog.
  await expect(
    discoverAgentModelsWithFetch(
      "generic",
      anthropicFormatCredential(),
      (request) => {
        if (request.headers.has("x-api-key")) {
          return Promise.resolve(
            createJsonResponse({
              data: [
                capabilityListing({
                  capabilities: {},
                  displayName: "Claude Test 4",
                  id: "claude-test-4",
                }),
              ],
              has_more: false,
            }),
          );
        }
        controller.abort(reason);
        // Returning a settled response lets the fetch promise finish without
        // producing a second rejection after the combined signal wins.
        return Promise.resolve(createJsonResponse({ data: [] }));
      },
      controller.signal,
    ),
  ).rejects.toThrow("aborted");
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
