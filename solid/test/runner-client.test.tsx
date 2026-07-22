import { test } from "vitest";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { RunnerPanel } from "../../solid/runner-client.tsx";
import { RunnerController } from "../../solid/runner-controller.ts";
import { runnerViewState } from "./client-state-fixtures.ts";
import { expectDefaultControls } from "./default-control-assertions.ts";
import { renderSolidToString } from "./render-solid.tsx";
import { runnerSummary } from "./runner-fixtures.ts";

const STATE = runnerViewState([
  { ...runnerSummary(1), isDefault: true },
  { ...runnerSummary(2), id: "runner-2", name: "laptop" },
]);

test("renders runner default controls", () => {
  const controller = new RunnerController(createReactiveState(STATE));
  const html = renderSolidToString(() => (
    <RunnerPanel controller={controller} />
  ));

  expectDefaultControls(
    html,
    "set-default-runner",
    "data-runner-id",
    "runner-2",
  );
});
