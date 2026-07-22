import { expect, test } from "vitest";
import {
  RenderDebugView,
  renderDebugLegend,
  renderDebugToggle,
} from "../../solid/render-debug.tsx";
import { renderSolidToString } from "./render-solid.tsx";

test("moves repeated boundary renders from green to red and resets", () => {
  const view = new RenderDebugView();

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

test("renders a debug toggle and a green-to-red legend", () => {
  const disabled = renderSolidToString(() => renderDebugToggle(false));
  const enabled = renderSolidToString(() => (
    <>
      {renderDebugToggle(true)}
      {renderDebugLegend()}
    </>
  ));

  expect(disabled).toContain('aria-pressed="false"');
  expect(disabled).toContain('data-action="toggle-render-debug"');
  expect(enabled).toContain('aria-pressed="true"');
  expect(enabled).toContain("Few renders");
  expect(enabled).toContain("Frequent renders");
  expect(enabled).toContain('data-action="reset-render-debug"');
});
