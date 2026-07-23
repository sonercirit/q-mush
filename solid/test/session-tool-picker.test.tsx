import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  AGENT_SESSION_TOOL_OPTIONS,
} from "../../shared/agent-tools.ts";
import { SessionToolPicker } from "../../solid/session-tool-picker.tsx";
import { renderSolidToString } from "./render-solid.tsx";

function renderPicker(): string {
  return renderSolidToString(() => (
    <SessionToolPicker
      disabled={false}
      onChange={() => undefined}
      tools={AGENT_SESSION_TOOL_NAMES}
    />
  ));
}

test("renders one details affordance for every canonical selectable tool", () => {
  const html = renderPicker();

  for (const option of AGENT_SESSION_TOOL_OPTIONS) {
    expect(html).toContain(`data-tool-details="${option.name}"`);
    expect(html).toContain(`aria-controls="tool-details-${option.name}"`);
    expect(html).toContain(`Details for ${option.name}`);
  }
  expect(html.match(/data-tool-details=/gu)).toHaveLength(
    AGENT_SESSION_TOOL_OPTIONS.length,
  );
});

test("renders session tools in one group with one group toggle", () => {
  const html = renderPicker();

  expect(html).toContain("Session tools");
  expect(html).toContain('name="session-tools"');
  for (const label of [
    "Spawn session",
    "List sessions",
    "Read session",
    "Send to session",
    "Continue session",
    "Stop session",
  ]) {
    expect(html).toContain(label);
  }
});
