import { render } from "solid-js/web";
import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { SessionToolPicker } from "../session-tool-picker.tsx";

function clickGroupToggle(
  tools: readonly AgentSessionToolName[],
): readonly AgentSessionToolName[] | undefined {
  let selected: readonly AgentSessionToolName[] | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <SessionToolPicker
        disabled={false}
        onChange={(nextTools) => {
          selected = nextTools;
        }}
        tools={tools}
      />
    ),
    container,
  );
  const control = container.querySelector("input[name='session-tools']");
  if (!(control instanceof HTMLInputElement)) {
    throw new TypeError("The session-tool group toggle was not rendered");
  }
  control.click();
  dispose();
  container.remove();
  return selected;
}

test("the group toggle enables every session tool in canonical order", () => {
  const toolsWithoutSessionGroup = AGENT_SESSION_TOOL_NAMES.filter(
    (name) => !SESSION_AGENT_TOOL_NAMES.includes(name),
  );
  expect(clickGroupToggle(toolsWithoutSessionGroup)).toEqual(
    AGENT_SESSION_TOOL_NAMES,
  );
});

test("the group toggle disables only session tools", () => {
  expect(clickGroupToggle(AGENT_SESSION_TOOL_NAMES)).toEqual(
    AGENT_SESSION_TOOL_NAMES.filter(
      (name) => !SESSION_AGENT_TOOL_NAMES.includes(name),
    ),
  );
});
