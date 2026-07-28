import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
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

test("renders a collapsed tool-list toggle", () => {
  const html = renderPicker();

  expect(html).toContain('data-tool-picker-toggle="true"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Expand tools");
  expect(html).not.toContain('data-tool-picker-controls="true"');
});

test("does not render the collapsed session tool group", () => {
  const html = renderPicker();

  expect(html).not.toContain("Session tools");
  expect(html).not.toContain('name="session-tools"');
});
