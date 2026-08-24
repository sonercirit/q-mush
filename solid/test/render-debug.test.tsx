import { type JSX } from "solid-js";
import { expect, test } from "vitest";
import {
  renderDebugBoundary,
  RenderDebugLegend,
  RenderDebugProvider,
  RenderDebugToggle,
  createRenderDebugView,
} from "../../solid/render-debug.tsx";
import { renderSolidToString } from "./render-solid.tsx";

function TestBoundary(): JSX.Element {
  return <div {...renderDebugBoundary("sessions", "Agent sessions panel")} />;
}

test("moves repeated boundary renders from green to red and resets", () => {
  const view = createRenderDebugView();

  expect(view.enabled).toBe(false);
  const firstMeasurement = view.record("sessions");
  expect(firstMeasurement.count).toBe(1);
  expect(firstMeasurement.heat).toBe("green");
  view.toggle();
  expect(view.enabled).toBe(true);

  const measurements = Array.from({ length: 8 }, () => view.record("sessions"));

  expect(measurements[0]).toEqual({ count: 2, heat: "green" });
  expect(measurements[1]).toEqual({ count: 3, heat: "lime" });
  expect(measurements[3]).toEqual({ count: 5, heat: "yellow" });
  expect(measurements[5]).toEqual({ count: 7, heat: "orange" });
  expect(measurements[7]).toEqual({ count: 9, heat: "red" });

  view.reset();
  const resetMeasurement = view.record("sessions");
  expect(resetMeasurement.count).toBe(1);
  expect(resetMeasurement.heat).toBe("green");
});

test("renders reactive boundary attributes through context", () => {
  const view = createRenderDebugView();
  view.toggle();

  const rendered = renderSolidToString(() => (
    <RenderDebugProvider staticView={view}>
      <TestBoundary />
    </RenderDebugProvider>
  ));

  expect(rendered).toContain('data-render-boundary="sessions"');
  expect(rendered).toContain('data-render-label="Agent sessions panel"');
  expect(rendered).toContain('data-render-count="1"');
  expect(rendered).toContain('data-render-debug="true"');
  expect(rendered).toContain('data-render-heat="green"');
});

test("renders a debug toggle and a green-to-red legend", () => {
  const disabledView = createRenderDebugView();
  const enabledView = createRenderDebugView();
  enabledView.toggle();
  const disabled = renderSolidToString(() => (
    <RenderDebugToggle view={disabledView} />
  ));
  const enabled = renderSolidToString(() => (
    <>
      <RenderDebugToggle view={enabledView} />
      <RenderDebugLegend view={enabledView} />
    </>
  ));

  expect(disabled).toContain('aria-pressed="false"');
  expect(enabled).toContain('aria-pressed="true"');
  expect(enabled).toContain("Few renders");
  expect(enabled).toContain("Frequent renders");
});
