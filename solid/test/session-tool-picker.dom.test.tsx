import { createComponent } from "solid-js";
import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { CONFIGURED_TOOL_SETTINGS } from "../../shared/test/tool-settings-fixtures.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  formatToolLimitsStatement,
  type ToolSettings,
} from "../../shared/tool-limits.ts";
import { SessionToolPicker } from "../session-tool-picker.tsx";
import { mountTestView } from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";

const disposals = trackedDisposals();
const DEFAULT_LIMITS_STATEMENT = formatToolLimitsStatement(
  DEFAULT_TOOL_SETTINGS,
);

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

test("does not claim default limits while current settings are unavailable", () => {
  const container = mountExpandedPicker(
    AGENT_SESSION_TOOL_NAMES,
    () => undefined,
  );

  expect(
    container.querySelector("[data-tool-limits-unavailable='true']")
      ?.textContent,
  ).toContain("unavailable");
  expect(container.querySelector("[data-tool-limits-note='true']")).toBeNull();
  expect(container.textContent).not.toContain(DEFAULT_LIMITS_STATEMENT);
});

test("shows the shared global limits once instead of per tool", () => {
  const container = mountExpandedPicker(
    AGENT_SESSION_TOOL_NAMES,
    () => undefined,
    DEFAULT_TOOL_SETTINGS,
  );
  const note = container.querySelector("[data-tool-limits-note='true']");

  expect(note?.textContent).toBe(DEFAULT_LIMITS_STATEMENT);
  expect(
    container.querySelectorAll("[data-tool-limits-note='true']"),
  ).toHaveLength(1);
});

test("shows configured limits exactly once", () => {
  const settings = CONFIGURED_TOOL_SETTINGS;
  const container = mountExpandedPicker(
    AGENT_SESSION_TOOL_NAMES,
    () => undefined,
    settings,
  );

  expect(
    container.querySelectorAll("[data-tool-limits-note='true']"),
  ).toHaveLength(1);
  expect(container.textContent).toContain(formatToolLimitsStatement(settings));
  expect(container.textContent).not.toContain(DEFAULT_LIMITS_STATEMENT);
  const bashDetails = container.querySelector<HTMLButtonElement>(
    "[data-tool-details='bash']",
  );
  bashDetails?.click();
  expect(
    container.querySelector("[data-tool-detail-panel='bash']")?.textContent,
  ).toContain("420");
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
