import { expect, test } from "vitest";
import {
  GENERIC_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
  ProviderPanel,
} from "../../solid/provider-client.tsx";
import { createProviderController } from "../../solid/provider-controller.ts";
import type { ProviderPanelConfiguration } from "../../solid/provider-panel-configuration.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { providerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
import { openAiProviderPanel } from "./provider-panel-fixtures.tsx";
import { renderSolidToString } from "./render-solid.tsx";

function credentialState(options: {
  readonly accountId: string | null;
  readonly id: string;
  readonly label: string;
}) {
  return providerViewState([
    {
      ...options,
      isDefault: true,
      requiresReauthentication: true,
      source: "oauth",
    },
  ]);
}

function renderedProviderPanel(
  configuration: ProviderPanelConfiguration,
  state: ReturnType<typeof providerViewState>,
): string {
  const controller = createProviderController(
    configuration,
    createReactiveState(state),
  );
  return renderSolidToString(() => (
    <ProviderPanel configuration={configuration} controller={controller} />
  ));
}

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
  const controller = createProviderController(
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
        {
          accountId: null,
          apiFormat: "anthropic",
          baseUrl: "https://anthropic.example.test/v1",
          id: "anthropic-credential",
          isDefault: false,
          label: "Claude proxy",
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
  expect(html).toContain("API format");
  expect(html).toContain('name="apiFormat"');
  expect(html).toContain("Anthropic messages");
  expect(html).toContain("OpenAI API endpoint");
  expect(html).toContain("Anthropic API endpoint");
  expect(html).not.toContain("Quota");
});

test("surfaces an explicit OpenAI re-login state", () => {
  const html = renderedProviderPanel(
    OPENAI_PANEL,
    credentialState({
      accountId: "account-1",
      id: "credential-1",
      label: "Expired account",
    }),
  );

  expect(html).toContain("Re-login required");
  expect(html).toContain("This OpenAI login has expired.");
  expect(html).toContain("Reconnect this account");
  expect(html).toContain(
    "/api/openai/oauth?workspaceId=global&credentialId=credential-1",
  );
});

test("uses the configured provider name in the shared re-login state", () => {
  const html = renderedProviderPanel(
    OPENROUTER_PANEL,
    credentialState({
      accountId: "openrouter-account",
      id: "openrouter-credential",
      label: "Expired OpenRouter account",
    }),
  );

  expect(html).toContain("This OpenRouter login has expired.");
  expect(html).toContain("Reconnect this account");
  expect(html).not.toContain("This OpenAI login has expired");
});

test.each([
  [OPENAI_PANEL, "OpenAI", "unverified-openai-credential"],
  [OPENROUTER_PANEL, "OpenRouter", "unverified-openrouter-credential"],
])(
  "directs an unverifiable %s account through viable recovery",
  (panel, providerName, credentialId) => {
    const html = renderedProviderPanel(
      panel,
      credentialState({
        accountId: null,
        id: credentialId,
        label: `Unverified ${providerName} account`,
      }),
    );

    expect(html).toContain(`This ${providerName} login has expired.`);
    expect(html).toContain(`has no verified ${providerName} account ID`);
    expect(html).toContain(
      `Remove it, then connect ${providerName} again as a new credential.`,
    );
    expect(html).not.toContain("Reconnect this account");
    expect(html).not.toContain(`credentialId=${credentialId}`);
  },
);

test("renders provider default controls", () => {
  const controller = createProviderController(
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
