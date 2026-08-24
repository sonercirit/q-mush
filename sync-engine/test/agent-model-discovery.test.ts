import { describe, expect, test } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../../shared/provider-credential-store.ts";
import { utf8ByteLength } from "../../shared/utf8.ts";
import {
  isCredentialRejectionError,
  type AgentModelDiscoveryFetch,
} from "../../sync-engine/agent-model-discovery-fetch.ts";
import { modelOption } from "../../sync-engine/agent-model-discovery-option.ts";
import { discoverAgentModelsWithFetch } from "../../sync-engine/agent-model-discovery.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { catalog, credential, model } from "./agent-model-discovery-helpers.ts";
import {
  abortAndObserveCanceledReader,
  stalledResponseReaderFixture,
} from "./discovery-cancellation-fixtures.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";
import { captureRejection } from "./promise-test-helpers.ts";

function deferredSignal() {
  return Promise.withResolvers<undefined>();
}

interface RequestCapture {
  request?: Request;
}

function createRequestCapture(): RequestCapture {
  return {};
}

function discoveryFetch(
  body: unknown,
  capture: RequestCapture,
): AgentModelDiscoveryFetch {
  return (request) => {
    capture.request = request;
    return Promise.resolve(createJsonResponse(body));
  };
}

async function capturedDiscovery(
  provider: ProviderId,
  providerCredential: ProviderCredentialAccess,
  body: unknown,
): Promise<{ readonly catalog: AgentModelCatalog; readonly request: Request }> {
  const capture = createRequestCapture();
  const discovered = await discoverAgentModelsWithFetch(
    provider,
    providerCredential,
    discoveryFetch(body, capture),
  );

  if (capture.request === undefined) {
    throw new Error("Model discovery did not make a request");
  }

  return { catalog: discovered, request: capture.request };
}

function openAiDiscovery(
  response: Response,
  signal?: AbortSignal,
): Promise<AgentModelCatalog> {
  return discoverAgentModelsWithFetch(
    "openai",
    credential("api_key", "sk-openai-secret"),
    () => Promise.resolve(response),
    signal,
  );
}

function rejectedDiscovery(body: BodyInit): Promise<AgentModelCatalog> {
  return openAiDiscovery(
    new Response(body, {
      headers: { "content-type": "application/json" },
    }),
  );
}

function openRouterStatusFailure(
  secret: string,
  status: number,
): Promise<AgentModelCatalog> {
  return discoverAgentModelsWithFetch(
    "openrouter",
    credential("api_key", secret),
    () => Promise.resolve(new Response("denied", { status })),
  );
}

function expectBearer(request: Request, token: string): void {
  expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
}

describe("agent model discovery", () => {
  test("discovers the account's visible Codex models and reasoning efforts", async () => {
    const oauthSecret = createOpenAiOAuthSecret();
    const { catalog: discovered, request } = await capturedDiscovery(
      "openai",
      credential("oauth", oauthSecret, "chatgpt-account"),
      {
        models: [
          {
            display_name: "Hidden model",
            priority: 0,
            slug: "gpt-hidden",
            supported_reasoning_levels: [],
            visibility: "hide",
          },
          {
            capabilities: { context_window: 128_000 },
            display_name: "GPT Live Mini",
            input_modalities: ["text"],
            priority: 2,
            slug: "gpt-live-mini",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
            ],
            visibility: "list",
          },
          {
            context_window_size: 200_000,
            display_name: "GPT Live",
            input_modalities: ["text", "image", "audio"],
            priority: 1,
            slug: "gpt-live",
            supported_reasoning_levels: [
              { effort: "high" },
              { effort: "xhigh" },
              { effort: "ultra" },
            ],
            visibility: "list",
          },
        ],
      },
    );

    expect(discovered).toEqual(
      catalog("gpt-live", [
        model("gpt-live", "GPT Live", ["high", "xhigh"], 200_000, [
          "text",
          "image",
          "audio",
        ]),
        model("gpt-live-mini", "GPT Live Mini", ["low", "medium"], 128_000, [
          "text",
        ]),
      ]),
    );
    expect(
      request.url.startsWith(
        "https://chatgpt.com/backend-api/codex/models?client_version=",
      ),
    ).toBe(true);
    expectBearer(request, "oauth-access-token");
    expect(request.headers.get("chatgpt-account-id")).toBe("chatgpt-account");
  });

  test("discovers tool-capable OpenRouter models and gateway reasoning metadata", async () => {
    const { catalog: discovered, request } = await capturedDiscovery(
      "openrouter",
      credential("api_key", "sk-or-secret"),
      {
        data: [
          {
            id: "vendor/no-tools",
            name: "No tools",
            supported_parameters: ["temperature"],
          },
          {
            architecture: {
              input_modalities: ["text", "image", "file"],
              output_modalities: ["text", "image"],
            },
            context_length: 131_072,
            id: "vendor/reasoning-model",
            name: "Reasoning Model",
            pricing: {
              cached_input: "0.0000001",
              completion: "0.0000016",
              prompt: "0.0000004",
            },
            reasoning: {
              default_effort: "medium",
              supported_efforts: ["low", "medium", "high", "max"],
            },
            supported_parameters: ["tools", "reasoning"],
          },
          {
            id: "vendor/unspecified-efforts",
            name: "Unspecified Efforts",
            reasoning: { supported_efforts: null },
            supported_parameters: ["tools", "reasoning"],
          },
        ],
      },
    );

    expect(discovered).toEqual(
      catalog("vendor/reasoning-model", [
        model(
          "vendor/reasoning-model",
          "Reasoning Model",
          ["low", "medium", "high", "max"],
          131_072,
          ["text", "image", "file"],
          ["text", "image"],
          {
            cachedInput: "0.0000001",
            input: "0.0000004",
            output: "0.0000016",
          },
        ),
        model("vendor/unspecified-efforts", "Unspecified Efforts", []),
      ]),
    );
    expect(request.url).toBe("https://openrouter.ai/api/v1/models/user");
    expectBearer(request, "sk-or-secret");
  });

  test("discovers models from a generic OpenAI-compatible API base URL", async () => {
    const { catalog: discovered, request } = await capturedDiscovery(
      "generic",
      credential(
        "api_key",
        "generic-secret",
        null,
        "https://models.example.test/openai/v1",
      ),
      {
        data: [
          {
            context_window: 65_536,
            id: "llama-3.3-70b",
            input_modalities: ["text"],
            name: "Llama 3.3 70B",
            supported_reasoning_levels: ["low", "high"],
          },
          { id: "embedding-model", name: "Unclassified model" },
        ],
      },
    );

    expect(discovered).toEqual(
      catalog("llama-3.3-70b", [
        model("llama-3.3-70b", "Llama 3.3 70B", ["low", "high"], 65_536, [
          "text",
        ]),
        model("embedding-model", "Unclassified model", []),
      ]),
    );
    expect(request.url).toBe("https://models.example.test/openai/v1/models");
    expectBearer(request, "generic-secret");
  });

  test("aborts and cancels a stalled discovery response body", async () => {
    const controller = new AbortController();
    const canceled = deferredSignal();
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled.resolve(undefined);
      },
      pull: () => {
        // Intentionally stall after the response headers arrive.
      },
    });
    const pending = discoverAgentModelsWithFetch(
      "openai",
      credential("api_key", "sk-openai-secret"),
      () => Promise.resolve(new Response(body)),
      controller.signal,
    );
    const captured = pending.catch((error: unknown) => error);
    const reason = new DOMException("Deadline reached", "AbortError");

    await Promise.resolve();
    controller.abort(reason);

    await expect(captured).resolves.toBe(reason);
    await expect(canceled.promise).resolves.toBeUndefined();
  });

  test("settles abort promptly while body cancellation finishes later", async () => {
    const fixture = stalledResponseReaderFixture();
    const { captured, controller } = fixture.start(openAiDiscovery);

    await abortAndObserveCanceledReader(fixture, captured, controller);
  });

  test("aborts an oversized streamed catalog before fully buffering it", async () => {
    const maximumBytes = 5 * 1024 * 1024;
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true;
      },
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });

    await expect(rejectedDiscovery(body)).rejects.toThrow(
      "provider model catalog was too large",
    );
    expect(pulls).toBeLessThanOrEqual(maximumBytes / (1024 * 1024) + 2);
    expect(canceled).toBe(true);
  });

  test("rejects malformed UTF-8 model catalogs", async () => {
    await expect(
      rejectedDiscovery(new Uint8Array([0x7b, 0xff, 0x7d])),
    ).rejects.toThrow("invalid model catalog");
  });

  test("rejects a catalog with too many model options", async () => {
    await expect(
      capturedDiscovery("openai", credential("api_key", "sk-openai-secret"), {
        data: Array.from({ length: 10_001 }, (_, index) => ({
          id: `gpt-catalog-${String(index)}`,
        })),
      }),
    ).rejects.toThrow("provider model catalog has too many options");
  });

  test("bounds long multibyte model strings and nested metadata", async () => {
    const multibyte = "É😀".repeat(500);
    const { catalog: discovered } = await capturedDiscovery(
      "openrouter",
      credential("api_key", "sk-or-secret"),
      {
        data: [
          {
            architecture: {
              input_modalities: Array.from(
                { length: 200 },
                (_, index) => `${String(index).padStart(3, "0")}-${multibyte}`,
              ),
              output_modalities: [multibyte],
            },
            id: "vendor/bounded-model",
            name: multibyte,
            pricing: { prompt: multibyte },
            supported_parameters: ["tools"],
          },
        ],
      },
    );
    const [bounded] = discovered.models;

    expect(bounded).toBeDefined();
    expect(utf8ByteLength(bounded?.label ?? "")).toBeLessThanOrEqual(300);
    expect(bounded?.inputModalities).toHaveLength(20);
    expect(
      bounded?.inputModalities?.every(
        (value) => utf8ByteLength(value) <= 100 && !value.includes("�"),
      ),
    ).toBe(true);
    expect(
      utf8ByteLength(String(bounded?.pricing?.input ?? "")),
    ).toBeLessThanOrEqual(100);
    expect(JSON.stringify(discovered)).not.toContain("�");
  });

  test("classifies exhausted OpenRouter credits without exposing credentials", async () => {
    const secret = "sk-never-return-this-secret";
    const error = await captureRejection(openRouterStatusFailure(secret, 402));
    const message = error instanceof Error ? error.message : String(error);

    expect(error).toMatchObject({ status: 402 });
    expect(isCredentialRejectionError(error)).toBe(true);
    expect(message).toContain("status 402");
    expect(message).not.toContain(secret);
    expect(utf8ByteLength(message)).toBeLessThanOrEqual(300);
  });

  test("discovers compatible models available to an OpenAI API key", async () => {
    const availableModels = [
      { id: "text-embedding-3-small" },
      { context_window: 1_047_576, id: "gpt-live" },
      { id: "gpt-live-audio-preview" },
      { id: "gpt-4.1-mini" },
    ];
    const result = await capturedDiscovery(
      "openai",
      credential("api_key", "sk-openai-secret"),
      { data: availableModels },
    );
    const { catalog: discovered, request } = result;

    expect(discovered).toEqual(
      catalog("gpt-live", [
        model("gpt-live", "gpt-live", [], 1_047_576),
        model("gpt-4.1-mini", "gpt-4.1-mini", []),
      ]),
    );
    expect(request.url).toBe("https://api.openai.com/v1/models");
    expectBearer(request, "sk-openai-secret");
  });
});

test("inherited model metadata keys are not treated as present", () => {
  const metadata: Record<string, unknown> = { id: "inherited-metadata" };
  Object.setPrototypeOf(metadata, { toString: 16_384 });

  expect(
    modelOption(metadata, "id", "name", [], ["toString"])?.contextWindow,
  ).toBeNull();
});
