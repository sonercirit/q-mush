import { expect, test } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import { renderSessionPanel } from "./render-session-panel.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionClientTestState } from "./session-client-test-state.ts";

const OPENROUTER_CREDENTIAL = "openrouter:credential-1";
const MODEL_CATALOG: AgentModelCatalog = testAgentModelCatalog();
const OPENROUTER = providerViewState([
  {
    accountId: null,
    id: "credential-1",
    isDefault: true,
    label: "OpenRouter",
    source: "api_key",
  },
]);
const RUNNERS = runnerViewState([runnerSummary(1)]);

function state() {
  const initial = sessionClientTestState();
  return {
    ...initial,
    draft: {
      ...initial.draft,
      credential: OPENROUTER_CREDENTIAL,
      model: "vendor/model",
      openRouterProviderTag: "together",
    },
    modelDiscovery: {
      catalog: MODEL_CATALOG,
      credential: OPENROUTER_CREDENTIAL,
      error: undefined,
      loading: false,
    },
    openSelect: "openRouterProviderTag" as const,
    providerDiscovery: {
      catalog: {
        providers: [
          {
            contextWindow: 64_000,
            name: "Together",
            pricing: null,
            tag: "together",
          },
        ],
      },
      error: undefined,
      key: `${OPENROUTER_CREDENTIAL}\nvendor/model`,
      loading: false,
    },
  };
}

test("renders automatic and explicit OpenRouter serving-provider choices", () => {
  const html = renderSessionPanel(state(), {
    openAi: providerViewState([]),
    openRouter: OPENROUTER,
    runners: RUNNERS,
  });

  expect(html).toContain('data-custom-select="openRouterProviderTag"');
  expect(html).toContain("Serving provider");
  expect(html).toContain("OpenRouter automatic routing");
  expect(html).toContain('data-option-value="together"');
  expect(html).toContain("64K context");
});

test("keeps automatic routing available when discovery fails", () => {
  const selected = state();
  const html = renderSessionPanel(
    {
      ...selected,
      draft: { ...selected.draft, openRouterProviderTag: "" },
      providerDiscovery: {
        catalog: undefined,
        error: "failed",
        key: `${OPENROUTER_CREDENTIAL}\nvendor/model`,
        loading: false,
      },
    },
    {
      openAi: providerViewState([]),
      openRouter: OPENROUTER,
      runners: RUNNERS,
    },
  );

  expect(html).toContain("Serving providers unavailable");
  expect(html).toContain("Automatic routing is available");
  expect(html).toContain("Retry serving-provider discovery");
});
