import { expect, test } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import { renderSessionPanel } from "./render-session-panel.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { discoveredSessionState } from "./session-client-render-fixtures.tsx";

const OPENROUTER_STATE = providerViewState([
  {
    accountId: null,
    id: "router-credential",
    isDefault: true,
    label: "OpenRouter",
    source: "api_key",
  },
]);
const OPENAI_STATE = providerViewState([
  {
    accountId: null,
    id: "credential",
    isDefault: true,
    label: "OpenAI",
    source: "api_key",
  },
]);
const EMPTY_PROVIDER_STATE = providerViewState([]);
const RUNNER_STATE = runnerViewState([runnerSummary(1)]);
const OPENROUTER_MODEL_CATALOG: AgentModelCatalog = {
  defaultModel: "vendor/model",
  models: [
    {
      contextWindow: 128_000,
      id: "vendor/model",
      inputModalities: ["text"],
      label: "Model",
      outputModalities: ["text"],
      pricing: { cachedInput: "0", input: "0", output: "0" },
      reasoningEfforts: [],
    },
  ],
};
const BASE_STATE = discoveredSessionState(
  "openrouter:router-credential",
  OPENROUTER_MODEL_CATALOG,
  { runnerId: "runner-1" },
  {
    providerDiscovery: {
      catalog: undefined,
      error: undefined,
      key: "openrouter:router-credential\nvendor/model",
      loading: false,
    },
  },
);

function renderPanel(
  state = BASE_STATE,
  openAi = EMPTY_PROVIDER_STATE,
  openRouter = OPENROUTER_STATE,
): string {
  return renderSessionPanel(state, {
    openAi,
    openRouter,
    runners: RUNNER_STATE,
  });
}

test("shows an accessible OpenRouter serving-provider selector only for OpenRouter", () => {
  const openRouterState = {
    ...BASE_STATE,
    draft: { ...BASE_STATE.draft, openRouterProviderTag: "together" },
    openSelect: "openRouterProviderTag" as const,
    providerDiscovery: {
      catalog: {
        providers: [
          {
            contextWindow: 64_000,
            name: "Together",
            pricing: { cachedInput: "0", input: "0.1", output: "0.2" },
            tag: "together",
          },
        ],
      },
      error: undefined,
      key: "openrouter:router-credential\nvendor/model",
      loading: false,
    },
  };
  const html = renderPanel(openRouterState);

  expect(html).toContain('data-custom-select="openRouterProviderTag"');
  expect(html).toContain('id="session-openrouter-provider"');
  expect(html).toContain("Serving provider");
  expect(html).toContain("OpenRouter automatic routing");
  expect(html).toContain('data-option-value="together"');
  expect(html).toContain("Together");
  expect(html).toContain('aria-live="polite"');
  expect(
    renderPanel(
      discoveredSessionState("openai:credential", OPENROUTER_MODEL_CATALOG, {
        runnerId: "runner-1",
      }),
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  ).not.toContain('data-custom-select="openRouterProviderTag"');
});

test("honestly reports loading, empty, and unavailable provider discovery", () => {
  const renderDiscovery = (
    providerDiscovery: (typeof BASE_STATE)["providerDiscovery"],
  ) => renderPanel({ ...BASE_STATE, providerDiscovery });
  const key = "openrouter:router-credential\nvendor/model";

  expect(
    renderDiscovery({
      catalog: undefined,
      error: undefined,
      key,
      loading: true,
    }),
  ).toContain("Loading available serving providers…");
  expect(
    renderDiscovery({
      catalog: { providers: [] },
      error: undefined,
      key,
      loading: false,
    }),
  ).toContain("No explicit serving providers are currently available");
  const unavailable = renderDiscovery({
    catalog: undefined,
    error: "failed",
    key,
    loading: false,
  });
  expect(unavailable).toContain("Serving providers unavailable");
  expect(unavailable).toContain("Automatic routing is available");
  expect(unavailable).toContain("Retry serving-provider discovery");
});
