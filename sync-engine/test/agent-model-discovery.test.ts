import { describe, expect, test } from "vitest";
import type {
  AgentModelCatalog,
  AgentModelOption,
  AgentReasoningEffort,
} from "../../shared/agent-configuration.ts";
import type {
  ProviderCredentialAccess,
  ProviderCredentialSource,
  ProviderId,
} from "../../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../../shared/provider-model-pricing.ts";
import { discoverAgentModels } from "../../sync-engine/agent-model-discovery.ts";
import { createJsonResponse } from "../../sync-engine/http.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";

type AgentModelDiscoveryFetch = (request: Request) => Promise<Response>;

class RequestCapture {
  request?: Request;
}

function credential(
  source: ProviderCredentialSource,
  secret: string,
  accountId: string | null = null,
): ProviderCredentialAccess {
  return {
    accountId,
    id: "credential-id",
    isDefault: false,
    label: "Provider credential",
    secret,
    source,
  };
}

function model(
  id: string,
  label: string,
  reasoningEfforts: readonly AgentReasoningEffort[],
  contextWindow: number | null = null,
  inputModalities: readonly string[] | null = null,
  outputModalities: readonly string[] | null = null,
  pricing: ProviderModelPricing | null = null,
): AgentModelOption {
  return {
    contextWindow,
    id,
    inputModalities,
    label,
    outputModalities,
    pricing,
    reasoningEfforts,
  };
}

function catalog(
  defaultModel: string,
  models: readonly AgentModelOption[],
): AgentModelCatalog {
  return { defaultModel, models };
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
  const capture = new RequestCapture();
  const discovered = await discoverAgentModels(
    provider,
    providerCredential,
    discoveryFetch(body, capture),
  );

  if (capture.request === undefined) {
    throw new Error("Model discovery did not make a request");
  }

  return { catalog: discovered, request: capture.request };
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
      ]),
    );
    expect(request.url).toBe("https://openrouter.ai/api/v1/models/user");
    expectBearer(request, "sk-or-secret");
  });

  test("discovers compatible models available to an OpenAI API key", async () => {
    const availableModels = [
      { id: "text-embedding-3-small" },
      { context_window: 1_047_576, id: "gpt-live" },
      { id: "gpt-live-audio-preview" },
    ];
    const result = await capturedDiscovery(
      "openai",
      credential("api_key", "sk-openai-secret"),
      { data: availableModels },
    );
    const { catalog: discovered, request } = result;

    expect(discovered).toEqual(
      catalog("gpt-live", [model("gpt-live", "gpt-live", [], 1_047_576)]),
    );
    expect(request.url).toBe("https://api.openai.com/v1/models");
    expectBearer(request, "sk-openai-secret");
  });
});
