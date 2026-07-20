import { describe, expect, test } from "bun:test";
import type {
  AgentModelCatalog,
  AgentModelOption,
  AgentReasoningEffort,
} from "../agent-configuration.ts";
import {
  discoverAgentModels,
  type AgentModelDiscoveryFetch,
} from "../agent-model-discovery.ts";
import { createJsonResponse } from "../http.ts";
import type {
  ProviderCredentialAccess,
  ProviderCredentialSource,
  ProviderId,
} from "../provider-credential-store.ts";
import { createOpenAiOAuthSecret } from "./oauth-test-helpers.ts";

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
    label: "Provider credential",
    secret,
    source,
  };
}

function model(
  id: string,
  label: string,
  reasoningEfforts: readonly AgentReasoningEffort[],
): AgentModelOption {
  return { id, label, reasoningEfforts };
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
            display_name: "GPT Live Mini",
            priority: 2,
            slug: "gpt-live-mini",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
            ],
            visibility: "list",
          },
          {
            display_name: "GPT Live",
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
        model("gpt-live", "GPT Live", ["high", "xhigh"]),
        model("gpt-live-mini", "GPT Live Mini", ["low", "medium"]),
      ]),
    );
    expect(request.url).toStartWith(
      "https://chatgpt.com/backend-api/codex/models?client_version=",
    );
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
            id: "vendor/reasoning-model",
            name: "Reasoning Model",
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
        model("vendor/reasoning-model", "Reasoning Model", [
          "low",
          "medium",
          "high",
          "max",
        ]),
      ]),
    );
    expect(request.url).toBe("https://openrouter.ai/api/v1/models/user");
    expectBearer(request, "sk-or-secret");
  });

  test("discovers compatible models available to an OpenAI API key", async () => {
    const availableModels = [
      { id: "text-embedding-3-small" },
      { id: "gpt-live" },
      { id: "gpt-live-audio-preview" },
    ];
    const result = await capturedDiscovery(
      "openai",
      credential("api_key", "sk-openai-secret"),
      { data: availableModels },
    );
    const { catalog: discovered, request } = result;

    expect(discovered).toEqual(
      catalog("gpt-live", [model("gpt-live", "gpt-live", [])]),
    );
    expect(request.url).toBe("https://api.openai.com/v1/models");
    expectBearer(request, "sk-openai-secret");
  });
});
