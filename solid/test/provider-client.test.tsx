import { test } from "vitest";
import {
  OPENAI_PANEL,
  renderProviderPanel,
} from "../../solid/provider-client.tsx";
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

test("renders provider default controls", () => {
  const html = renderSolidToString(() =>
    renderProviderPanel(OPENAI_PANEL, STATE),
  );

  expectDefaultControls(
    html,
    "set-default-provider-credential",
    "data-credential-id",
    "credential-2",
  );
});
