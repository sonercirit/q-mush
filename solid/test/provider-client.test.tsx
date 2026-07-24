import { expect, test } from "vitest";
import { OPENAI_PANEL, ProviderPanel } from "../../solid/provider-client.tsx";
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
    isGlobal: true,
    label: "Primary",
    source: "oauth",
    workspaceIds: [],
  },
  {
    accountId: "account-2",
    id: "credential-2",
    isDefault: false,
    isGlobal: false,
    label: "Backup",
    source: "api_key",
    workspaceIds: ["workspace-1"],
  },
]);

test("renders provider default and scope controls", () => {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(STATE),
  );
  const html = renderSolidToString(() => (
    <ProviderPanel
      configuration={OPENAI_PANEL}
      controller={controller}
      selectedWorkspaceId="workspace-1"
      workspaces={() => ({
        defaultWorkspaceId: "workspace-1",
        workspaces: [{ id: "workspace-1", isDefault: true, name: "Default" }],
      })}
    />
  ));

  expectDefaultControls(
    html,
    "set-default-provider-credential",
    "data-credential-id",
    "credential-2",
  );
  expect(html).toContain("Scope: Global");
  expect(html).toContain("Save scope");
  expect(html).toContain("/api/openai/oauth?workspaceId=workspace-1");
});
