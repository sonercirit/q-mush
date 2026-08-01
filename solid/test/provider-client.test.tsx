import { expect, test } from "vitest";
import {
  GENERIC_PANEL,
  OPENAI_PANEL,
  ProviderPanel,
} from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { providerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
import { openAiProviderPanel } from "./provider-panel-fixtures.tsx";
import { renderSolidToString } from "./render-solid.tsx";

const STATE = providerViewState([
  {
    accountId: "account-1",
    id: "credential-1",
    isDefault: true,
    label: "Primary",
    source: "oauth",
  },
  {
    accountId: "account-2",
    id: "credential-2",
    isDefault: false,
    label: "Backup",
    source: "api_key",
  },
]);

test("renders a generic endpoint form with an optional API key", () => {
  const controller = new ProviderController(
    GENERIC_PANEL,
    createReactiveState(
      providerViewState([
        {
          accountId: null,
          baseUrl: "http://localhost:11434/v1",
          id: "generic-credential",
          isDefault: false,
          label: "Local Ollama",
          source: "api_key",
        },
      ]),
    ),
  );
  const html = renderSolidToString(() => (
    <ProviderPanel configuration={GENERIC_PANEL} controller={controller} />
  ));

  expect(html).toContain("Generic LLM");
  expect(html).toContain("API base URL");
  expect(html).toContain('name="baseUrl"');
  expect(html).toContain("API key (optional)");
  expect(html).toContain("http://localhost:11434/v1");
  expect(html).toContain("Add provider");
  expect(html).not.toContain("Quota");
});

test("renders provider default controls", () => {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(STATE),
  );
  const html = renderSolidToString(() => openAiProviderPanel(controller));

  expectDefaultControls(
    html,
    "set-default-provider-credential",
    "data-credential-id",
    "credential-2",
  );
});
