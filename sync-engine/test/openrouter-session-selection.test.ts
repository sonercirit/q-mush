import { describe, expect, test } from "vitest";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../../shared/routes.ts";
import type { OpenRouterProviderDiscoverer } from "../../sync-engine/openrouter-provider-discovery.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createOpenRouterSessionRequest,
  CREDENTIAL_ID,
  OPENROUTER_PROVIDER_CATALOG,
} from "./session-integration-fixtures.ts";
import {
  discoverProvidersForCredential,
  expectJsonResponse,
  expectSessionReaches,
  postSessionAction,
  sendSessionMessage,
  waitForIdleContent,
} from "./session-integration-helpers.ts";

function createOpenRouterSession(
  setup: ReturnType<typeof connectedSessionSetup>,
  tag?: string,
): Promise<Response> {
  return Promise.resolve(
    setup.sessions.collection(createOpenRouterSessionRequest(tag)),
  );
}

describe("OpenRouter session provider selection", () => {
  test("discovers and validates an owned serving provider", async () => {
    const discoveryCalls: unknown[][] = [];
    const discoverProviders = (
      ...parameters: Parameters<OpenRouterProviderDiscoverer>
    ) => {
      discoveryCalls.push(parameters);
      return Promise.resolve(OPENROUTER_PROVIDER_CATALOG);
    };
    const setup = connectedSessionSetup(
      new ScriptedAgentModel([{ content: "Done.", toolCalls: [] }]),
      "api_key",
      () => Promise.reject(new Error("Model metadata unavailable")),
      discoverProviders,
    );

    const providers = await setup.sessions.openRouterProviders(
      createAuthenticatedRequest(
        `${SESSION_OPENROUTER_PROVIDERS_PATH}?credentialId=${CREDENTIAL_ID}&model=anthropic%2Fclaude-3.5-sonnet`,
      ),
    );
    await expectJsonResponse(providers, 200, OPENROUTER_PROVIDER_CATALOG);

    const created = await createOpenRouterSession(setup, "together");
    expect(await created.clone().json()).toMatchObject({
      maxContextTokens: 64_000,
      openRouterProviderTag: "together",
      providerPricing: { input: "0.0000002", output: "0.0000008" },
    });
    await expectSessionReaches(setup, created, "idle");
    expect(setup.selectedProviders).toEqual(["openrouter"]);
    expect(setup.selectedOpenRouterProviderTags).toEqual(["together"]);
    expect(discoveryCalls).toHaveLength(2);
    expect(discoveryCalls[0]?.slice(0, 3)).toMatchObject([
      TEST_USER_ID,
      { id: CREDENTIAL_ID, secret: "provider-secret" },
      "anthropic/claude-3.5-sonnet",
    ]);
    expect(discoveryCalls[1]?.[3]).toEqual({ force: true });
    setup.database.$client.close();
  });

  test("preserves a serving provider through follow-ups, continues, and manual compaction", async () => {
    const model = new ScriptedAgentModel([
      { content: "Initial complete.", toolCalls: [] },
      { content: "Follow-up complete.", toolCalls: [] },
      { content: "Continue complete.", toolCalls: [] },
      { content: "Compacted handoff.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model, "api_key", undefined, () =>
      Promise.resolve(OPENROUTER_PROVIDER_CATALOG),
    );
    const created = await createOpenRouterSession(setup, "together");
    await expectSessionReaches(setup, created, "idle");

    const followUp = await sendSessionMessage(setup, "Follow up");
    expect(followUp.status).toBe(202);
    await waitForIdleContent(setup, "Follow-up complete.");

    await postSessionAction(setup, "continue", "Continue complete.");

    await postSessionAction(setup, "compact", "Compacted handoff.");

    expect(new Set(setup.selectedProviders)).toEqual(new Set(["openrouter"]));
    expect(setup.selectedProviders.length).toBeGreaterThanOrEqual(4);
    expect(setup.selectedOpenRouterProviderTags).toEqual(
      Array.from({ length: setup.selectedProviders.length }, () => "together"),
    );
    setup.database.$client.close();
  });

  test("rejects unavailable and failed provider validation", async () => {
    const unavailable = connectedSessionSetup(
      new ScriptedAgentModel([]),
      "api_key",
      undefined,
      () => Promise.resolve(OPENROUTER_PROVIDER_CATALOG),
    );

    await expectJsonResponse(
      await unavailable.sessions.collection(
        createOpenRouterSessionRequest("forged-provider"),
      ),
      409,
      { error: "openrouter_provider_unavailable" },
    );
    expect(unavailable.sessions.listForUser(TEST_USER_ID)).toEqual([]);
    unavailable.database.$client.close();

    const failed = connectedSessionSetup(
      new ScriptedAgentModel([]),
      "api_key",
      undefined,
      () => Promise.reject(new Error("OpenRouter unavailable")),
    );
    await expectJsonResponse(
      await failed.sessions.collection(
        createOpenRouterSessionRequest("together"),
      ),
      502,
      { error: "openrouter_provider_validation_failed" },
    );
    expect(failed.sessions.listForUser(TEST_USER_ID)).toEqual([]);
    failed.database.$client.close();
  });

  test("does not gate automatic routing on endpoint discovery", async () => {
    const setup = connectedSessionSetup(
      new ScriptedAgentModel([
        { content: "Automatically routed.", toolCalls: [] },
      ]),
      "api_key",
      undefined,
      () => Promise.reject(new Error("Endpoint discovery unavailable")),
    );

    const created = await createOpenRouterSession(setup);
    expect(await created.clone().json()).toMatchObject({
      openRouterProviderTag: null,
    });
    await expectSessionReaches(setup, created, "idle");
    setup.database.$client.close();
  });

  test("rejects discovery for another credential", async () => {
    const model = new ScriptedAgentModel([]);
    const setup = connectedSessionSetup(model);
    const response = await discoverProvidersForCredential(
      setup,
      "other-credential",
    );

    await expectJsonResponse(response, 409, {
      error: "credential_unavailable",
    });
    setup.database.$client.close();
  });
});
