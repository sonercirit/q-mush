import { createComponent } from "solid-js";
import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { CONFIGURED_TOOL_SETTINGS } from "../../shared/test/tool-settings-fixtures.ts";
import type { ToolSettings } from "../../shared/tool-limits.ts";
import { SessionToolPicker } from "../session-tool-picker.tsx";
import { mountTestView } from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";
import {
  expectConfiguredBashMaximum,
  expectNoToolLimitsNote,
} from "./session-tool-test-helpers.ts";

const disposals = trackedDisposals();
function mountExpandedPicker(
  tools: readonly AgentSessionToolName[],
  onChange: (nextTools: readonly AgentSessionToolName[]) => void,
  settings?: ToolSettings,
): HTMLDivElement {
  const container = mountTestView(
    () =>
      createComponent(SessionToolPicker, {
        disabled: false,
        onChange,
        ...(settings === undefined ? {} : { settings }),
        tools,
      }),
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

test("does not render the session-owned limits note", () => {
  const container = mountExpandedPicker(
    AGENT_SESSION_TOOL_NAMES,
    () => undefined,
    CONFIGURED_TOOL_SETTINGS,
  );

  expectNoToolLimitsNote(container);
  expect(
    container.querySelector("[data-tool-limits-unavailable='true']"),
  ).toBeNull();
  expectConfiguredBashMaximum(container);
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
