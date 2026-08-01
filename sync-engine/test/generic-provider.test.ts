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

  test("validates and stores an OpenAI-compatible endpoint with an optional API key", async () => {
    const requests: Request[] = [];
    const setup = genericSetup((input, init) => {
      recordProviderRequest(requests, input, init);
      return jsonProviderResponse({
        data: [{ id: "llama-3.3", name: "Llama 3.3" }],
      });
    });

    const response = await addGenericCredential(setup.integration, {
      baseUrl: "http://localhost:11434/v1/",
      label: "Local Ollama",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      accountId: null,
      baseUrl: "http://localhost:11434/v1",
      id: CREDENTIAL_ID,
      isDefault: false,
      isGlobal: true,
      label: "Local Ollama",
      source: "api_key",
      workspaceIds: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(
      await setup.integration.readCredential(TEST_USER_ID, CREDENTIAL_ID),
    ).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      secret: "",
    });
    setup.close();
  });

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
  ])("$name", async (failure) => {
    let requestCount = 0;
    const setup = genericSetup(() => {
      requestCount += 1;
      return jsonProviderResponse({ data: [] }, failure.providerStatus);
    });
    const response = await addGenericCredential(setup.integration, {
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
