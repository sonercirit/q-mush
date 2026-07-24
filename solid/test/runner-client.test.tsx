import { expect, test } from "vitest";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { RunnerPanel } from "../../solid/runner-client.tsx";
import { RunnerController } from "../../solid/runner-controller.ts";
import { runnerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
import { renderSolidToString } from "./render-solid.tsx";
import { runnerSummary } from "./runner-fixtures.ts";

const STATE = runnerViewState([
  { ...runnerSummary(1), isDefault: true, isGlobal: true, workspaceIds: [] },
  {
    ...runnerSummary(2),
    id: "runner-2",
    isGlobal: false,
    name: "laptop",
    workspaceIds: ["workspace-1"],
  },
]);

test("renders runner default and scope controls", () => {
  const controller = new RunnerController(createReactiveState(STATE));
  const html = renderSolidToString(() => (
    <RunnerPanel
      controller={controller}
      workspaces={() => ({
        defaultWorkspaceId: "workspace-1",
        workspaces: [{ id: "workspace-1", isDefault: true, name: "Default" }],
      })}
    />
  ));

  expectDefaultControls(
    html,
    "set-default-runner",
    "data-runner-id",
    "runner-2",
  );
  expect(html).toContain("Scope: Global");
  expect(html).toContain("Save scope");
});
