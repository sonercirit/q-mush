import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { normalizeGenericProviderBaseUrl } from "../../sync-engine/generic-provider-url.ts";
import {
  createGenericIntegrationFromEnvironment,
  type GenericProviderIntegration,
} from "../../sync-engine/generic-provider.ts";
import type { OAuthDependencies } from "../../sync-engine/oauth.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { recordProviderRequest } from "./provider-integration-test-helpers.ts";

const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000071";
const CREDENTIALS_PATH = "/api/generic/credentials";
const ENVIRONMENT = {
  GENERIC_CREDENTIAL_KEY: Buffer.alloc(32, 11).toString("base64url"),
};

type ProviderFetch = NonNullable<OAuthDependencies["fetch"]>;

function genericSetup(fetch: ProviderFetch) {
  const context = createAuthenticatedTestContext();
  const integration = createGenericIntegrationFromEnvironment(
    ENVIRONMENT,
    context.auth,
    {
      database: context.database,
      fetch,
      now: () => TEST_NOW,
      randomId: () => CREDENTIAL_ID,
    },
  );
  return {
    close: () => {
      context.database.$client.close();
    },
    integration,
  };
}

function addGenericCredential(
  integration: GenericProviderIntegration,
  input: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return integration.credentials(
    createAuthenticatedRequest(CREDENTIALS_PATH, input, "POST"),
  );
}

function jsonProviderResponse(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(Response.json(value, { status }));
}

describe("generic provider credentials", () => {
  test("normalizes HTTP(S) API base URLs without accepting URL credentials or parameters", () => {
    expect(
      normalizeGenericProviderBaseUrl(" http://localhost:11434/v1/ "),
    ).toBe("http://localhost:11434/v1");
    expect(
      normalizeGenericProviderBaseUrl("https://models.example.test/"),
    ).toBe("https://models.example.test");
    for (const invalid of [
      "https://user:secret@example.test/v1",
      "https://example.test/v1?token=secret",
      "file:///tmp/models",
    ]) {
      expect(normalizeGenericProviderBaseUrl(invalid)).toBeUndefined();
    }
  });

  async function expectStoredCredential(options: {
    readonly catalog: unknown;
    readonly input: Readonly<Record<string, unknown>>;
    readonly expectedResponse: Readonly<Record<string, unknown>>;
    readonly expectedStored: Readonly<Record<string, unknown>>;
    readonly inspectRequests: (requests: readonly Request[]) => void;
  }): Promise<void> {
    const requests: Request[] = [];
    const setup = genericSetup((input, init) => {
      recordProviderRequest(requests, input, init);
      return jsonProviderResponse(options.catalog);
    });

    const creation = await addGenericCredential(
      setup.integration,
      options.input,
    );

    expect(creation.status).toBe(201);
    expect(await creation.json()).toEqual(options.expectedResponse);
    options.inspectRequests(requests);
    expect(
      await setup.integration.readCredential(TEST_USER_ID, CREDENTIAL_ID),
    ).toMatchObject(options.expectedStored);
    setup.close();
  }

  test("validates and stores an OpenAI-compatible endpoint with an optional API key", () =>
    expectStoredCredential({
      catalog: { data: [{ id: "llama-3.3", name: "Llama 3.3" }] },
      expectedResponse: {
        accountId: null,
        baseUrl: "http://localhost:11434/v1",
        id: CREDENTIAL_ID,
        isDefault: false,
        isGlobal: true,
        label: "Local Ollama",
        source: "api_key",
        workspaceIds: [],
      },
      expectedStored: { baseUrl: "http://localhost:11434/v1", secret: "" },
      input: { baseUrl: "http://localhost:11434/v1/", label: "Local Ollama" },
      inspectRequests: (requests) => {
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("http://localhost:11434/v1/models");
        expect(requests[0]?.headers.has("authorization")).toBe(false);
      },
    }));

  test("validates and stores an Anthropic-format endpoint", () =>
    expectStoredCredential({
      catalog: {
        data: [
          { display_name: "Claude Test 4", id: "claude-test-4", type: "model" },
        ],
      },
      expectedResponse: {
        accountId: null,
        apiFormat: "anthropic",
        baseUrl: "https://anthropic.example.test/v1",
        id: CREDENTIAL_ID,
        isDefault: false,
        isGlobal: true,
        label: "Claude proxy",
        source: "api_key",
        workspaceIds: [],
      },
      expectedStored: { apiFormat: "anthropic", secret: "anthropic-key" },
      input: {
        apiFormat: "anthropic",
        apiKey: "anthropic-key",
        baseUrl: "https://anthropic.example.test/v1",
        label: "Claude proxy",
      },
      inspectRequests: (requests) => {
        // Anthropic-format validation also probes the OpenAI-style listing
        // for reasoning-effort metadata.
        expect(requests).toHaveLength(2);
        expect(requests[0]?.headers.get("x-api-key")).toBe("anthropic-key");
        expect(requests[0]?.headers.get("anthropic-version")).toBe(
          "2023-06-01",
        );
        expect(requests[1]?.headers.get("authorization")).toBe(
          "Bearer anthropic-key",
        );
      },
    }));

  test.each([
    {
      baseUrl: "https://models.example.test/v1",
      error: "invalid_api_key",
      expectedRequests: 1,
      key: "rejected-key",
      name: "reports a rejected generic API key without storing it",
      providerStatus: 401,
    },
    {
      baseUrl: "file:///private/provider",
      error: "invalid_request",
      expectedRequests: 0,
      key: "secret",
      name: "rejects malformed base URLs before making a provider request",
      providerStatus: 200,
    },
    {
      apiFormat: "gemini",
      baseUrl: "https://models.example.test/v1",
      error: "invalid_request",
      expectedRequests: 0,
      key: "secret",
      name: "rejects an unsupported API format without a provider request",
      providerStatus: 200,
    },
  ])("$name", async (failure) => {
    let requestCount = 0;
    const setup = genericSetup(() => {
      requestCount += 1;
      return jsonProviderResponse({ data: [] }, failure.providerStatus);
    });
    const response = await addGenericCredential(setup.integration, {
      ...("apiFormat" in failure ? { apiFormat: failure.apiFormat } : {}),
      apiKey: failure.key,
      baseUrl: failure.baseUrl,
      label: "Unavailable provider",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: failure.error });
    expect(requestCount).toBe(failure.expectedRequests);
    expect(
      await setup.integration.readCredential(TEST_USER_ID, CREDENTIAL_ID),
    ).toBeUndefined();
    setup.close();
  });
});
