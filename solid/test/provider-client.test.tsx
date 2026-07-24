import { expect, test } from "vitest";
import {
  BRAVE_SEARCH_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
  ProviderPanel,
} from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { providerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
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

function renderPanel(
  configuration: typeof OPENAI_PANEL,
  state = STATE,
): string {
  const controller = new ProviderController(
    configuration,
    createReactiveState(state),
  );
  return renderSolidToString(() => (
    <ProviderPanel configuration={configuration} controller={controller} />
  ));
}

test("renders standalone session switching for every model credential only", () => {
  for (const configuration of [OPENAI_PANEL, OPENROUTER_PANEL]) {
    const html = renderPanel(configuration);

    expect(html.match(/Switch sessions to this account/gu)).toHaveLength(2);
    expect(html).toContain('data-credential-id="credential-1"');
    expect(html).toContain('data-credential-id="credential-2"');
    expect(html).toContain("Default");
    expect(html).toContain("Make default");
  }

  const braveHtml = renderPanel(BRAVE_SEARCH_PANEL);
  expect(braveHtml).not.toContain("Switch sessions to this account");
});

test("renders provider default controls", () => {
  const html = renderPanel(OPENAI_PANEL);

  expectDefaultControls(
    html,
    "set-default-provider-credential",
    "data-credential-id",
    "credential-2",
  );
});
