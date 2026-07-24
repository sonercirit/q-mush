import { expect, test } from "vitest";
import type { SessionViewState } from "../session-client.tsx";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import {
  numberedCredentials,
  numberedModels,
  numberedRunners,
} from "./custom-select-consumer-fixtures.ts";
import {
  renderSessionPanelWithResources,
  SESSION_PANEL_TEST_CONTEXT,
} from "./session-panel-test-context.ts";

test("paginates every session select consumer without provider-specific behavior", () => {
  const sessionState = SESSION_PANEL_TEST_CONTEXT.state;
  const runners = numberedRunners();
  const credentials = numberedCredentials();
  const openAiCredentials = credentials.slice(0, 6);
  const openRouterCredentials = credentials.slice(6);
  const models = numberedModels();
  const baseState = {
    ...sessionState,
    draft: {
      ...sessionState.draft,
      credential: "openrouter:credential-12",
      model: "model-12",
      runnerId: "runner-12",
    },
    modelDiscovery: {
      catalog: { defaultModel: "model-1", models },
      credential: "openrouter:credential-12",
      error: undefined,
      loading: false,
    },
  };
  const states: readonly SessionViewState[] = [
    { ...baseState, openSelect: "runnerId" },
    { ...baseState, openSelect: "credential" },
    { ...baseState, openSelect: "model" },
  ];
  const html = states.map((state) =>
    renderSessionPanelWithResources(
      SESSION_PANEL_TEST_CONTEXT,
      state,
      runnerViewState(runners),
      providerViewState(openAiCredentials),
      providerViewState(openRouterCredentials),
    ),
  );

  for (const [index, name] of ["runnerId", "credential", "model"].entries()) {
    expect(html[index]).toContain(`data-custom-select-search="${name}"`);
    expect(html[index]).toContain(`data-custom-select-page="${name}"`);
  }
  const credentialHtml = html[1] ?? "";
  expect(credentialHtml).toContain(
    'data-option-value="openrouter:credential-12"',
  );
  expect(credentialHtml).toContain("OpenRouter · Credential 12");
  const modelHtml = html[2] ?? "";
  expect(modelHtml).toContain('data-option-value="model-12"');
  expect(modelHtml).not.toContain('data-option-value="model-1"');
  expect(modelHtml).toContain("Text, Image");
  expect(modelHtml).toContain("12K context");
});
