import { test } from "vitest";
import { OPENAI_PANEL, ProviderPanel } from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { providerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
import { renderSolidToString } from "./render-solid.tsx";

const TEST_LIMITS = { status: "unavailable" as const };

const STATE = providerViewState([
  {
    accountId: "account-1",
    id: "credential-1",
    isDefault: true,
    label: "Primary",
    limits: TEST_LIMITS,
    source: "oauth",
  },
  {
    accountId: "account-2",
    id: "credential-2",
    isDefault: false,
    label: "Backup",
    limits: TEST_LIMITS,
    source: "api_key",
  },
]);

test("renders provider default controls", () => {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(STATE),
  );
  const html = renderSolidToString(() => (
    <ProviderPanel configuration={OPENAI_PANEL} controller={controller} />
  ));

  expectDefaultControls(
    html,
    "set-default-provider-credential",
    "data-credential-id",
    "credential-2",
  );
});
