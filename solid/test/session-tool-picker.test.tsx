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
