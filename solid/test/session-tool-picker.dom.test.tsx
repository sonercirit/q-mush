import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { SHARED_TOOL_LIMITS_STATEMENT } from "../../shared/tool-limits.ts";
import { SessionToolPicker } from "../session-tool-picker.tsx";
import { mountTestView } from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";

const disposals = trackedDisposals();

function mountExpandedPicker(
  tools: readonly AgentSessionToolName[],
  onChange: (nextTools: readonly AgentSessionToolName[]) => void,
): HTMLDivElement {
  const pickerProps = { disabled: false, onChange, tools };
  const container = mountTestView(
    () => <SessionToolPicker {...pickerProps} />,
    disposals,
  );
  const expand = container.querySelector("[data-tool-picker-toggle='true']");
  if (!(expand instanceof HTMLButtonElement)) {
    throw new TypeError("The session-tool picker toggle was not rendered");
  }
  expand.click();
  return container;
}

function clickGroupToggle(
  tools: readonly AgentSessionToolName[],
): readonly AgentSessionToolName[] | undefined {
  let selected: readonly AgentSessionToolName[] | undefined;
  const container = mountExpandedPicker(tools, (nextTools) => {
    selected = nextTools;
  });
  const control = container.querySelector("input[name='session-tools']");
  if (!(control instanceof HTMLInputElement)) {
    throw new TypeError("The session-tool group toggle was not rendered");
  }
  control.click();
  return selected;
}

test("shows the shared global limits once instead of per tool", () => {
  const container = mountExpandedPicker(
    AGENT_SESSION_TOOL_NAMES,
    () => undefined,
  );
  const note = container.querySelector("[data-tool-limits-note='true']");

  expect(note?.textContent).toBe(SHARED_TOOL_LIMITS_STATEMENT);
  expect(
    container.querySelectorAll("[data-tool-limits-note='true']"),
  ).toHaveLength(1);
});

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
