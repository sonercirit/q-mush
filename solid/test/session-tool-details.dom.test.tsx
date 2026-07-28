import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  AGENT_SESSION_TOOL_OPTIONS,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import { SessionToolPicker } from "../session-tool-picker.tsx";

interface MountedPicker {
  readonly changes: readonly (readonly AgentSessionToolName[])[];
  readonly container: HTMLElement;
  readonly dispose: () => void;
}

const mounted: MountedPicker[] = [];

function renderPicker(
  container: HTMLElement,
  onChange: (tools: readonly AgentSessionToolName[]) => void,
): () => void {
  return render(
    () => (
      <SessionToolPicker
        disabled={false}
        onChange={onChange}
        tools={AGENT_SESSION_TOOL_NAMES}
      />
    ),
    container,
  );
}

function mountPicker(): MountedPicker {
  const changes: (readonly AgentSessionToolName[])[] = [];
  const host = document.createElement("section");
  host.dataset["testView"] = "tool-details";
  document.body.append(host);
  const dispose = renderPicker(host, (tools) => {
    changes.push(tools);
  });
  const result = {
    changes,
    container: host,
    dispose,
  };
  mounted.push(result);
  return result;
}

function expandPicker(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector("[data-tool-picker-toggle='true']");
  if (!(toggle instanceof HTMLButtonElement)) {
    throw new TypeError("The tool-picker expand toggle was not rendered");
  }
  toggle.click();
  return toggle;
}

function mountExpandedPicker(): MountedPicker {
  const picker = mountPicker();
  expandPicker(picker.container);
  return picker;
}

function infoButton(
  container: HTMLElement,
  name: AgentSessionToolName,
): HTMLButtonElement {
  const button = container.querySelector(`button[data-tool-details='${name}']`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new TypeError(`Missing ${name} details button`);
  }
  return button;
}

function openPanel(
  container: HTMLElement,
  name: AgentSessionToolName,
): HTMLElement {
  infoButton(container, name).click();
  const panel = container.querySelector(`[data-tool-detail-panel='${name}']`);
  if (!(panel instanceof HTMLElement)) {
    throw new TypeError(`Missing ${name} details panel`);
  }
  return panel;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dispose();
    view.container.remove();
  }
});

function toolInputCount(container: HTMLElement): number {
  return container.querySelectorAll("input[name='tools']").length;
}

test("expands from the toggle and collapses the complete tool controls", () => {
  const { container } = mountPicker();
  const toggle = expandPicker(container);

  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toContain("Collapse");
  expect(toolInputCount(container)).toBe(AGENT_SESSION_TOOL_NAMES.length);
  expect(
    container.querySelector("[data-tool-picker-controls='true']"),
  ).toBeInstanceOf(HTMLDivElement);

  toggle.click();

  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("Expand");
  expect(toolInputCount(container)).toBe(0);
  expect(container.querySelector("input[name='session-tools']")).toBeNull();
});

test("renders an accessible info button for every canonical picker row", () => {
  const { container } = mountExpandedPicker();
  const buttons = container.querySelectorAll("button[data-tool-details]");

  expect(buttons).toHaveLength(AGENT_SESSION_TOOL_OPTIONS.length);
  expect(
    [...buttons].map((button) => button.getAttribute("data-tool-details")),
  ).toEqual(AGENT_SESSION_TOOL_OPTIONS.map(({ name }) => name));
  for (const option of AGENT_SESSION_TOOL_OPTIONS) {
    const button = infoButton(container, option.name);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(
      `tool-details-${option.name}`,
    );
    expect(button.getAttribute("aria-label")).toContain(option.name);
  }
});

test("shows authoritative descriptions, classifications, and nested schema details", () => {
  const { container } = mountExpandedPicker();
  const bash = openPanel(container, "bash");

  expect(bash.textContent).toContain("bash");
  expect(bash.textContent).toContain("Runner tool");
  expect(bash.textContent).toContain(
    AGENT_SESSION_TOOL_OPTIONS.find(({ name }) => name === "bash")?.description,
  );
  expect(bash.textContent).toContain("command");
  expect(bash.textContent).toContain("string");
  expect(bash.textContent).toContain("Required");
  expect(bash.textContent).toContain("timeout");
  expect(bash.textContent).toContain("Minimum: 1");

  const parallel = openPanel(container, "parallel");
  expect(parallel.textContent).toContain("tool_uses");
  expect(parallel.textContent).toContain("Array of object");
  expect(parallel.textContent).toContain("Minimum items: 2");
  expect(parallel.textContent).toContain("recipient_name");
  expect(parallel.textContent).toContain("Additional properties: not allowed");
  expect(parallel.textContent).toContain("Additional properties: allowed");
  expect(parallel.textContent).toContain("Allowed values:");
  expect(parallel.textContent).not.toContain("Maximum items");

  const search = openPanel(container, "brave_search");
  expect(search.textContent).toContain("Skill");
  expect(search.textContent).toContain("Optional");
  expect(search.textContent).toContain("Minimum: 1");
  expect(search.textContent).toContain("Maximum: 20");

  const session = openPanel(container, "spawn_session");
  expect(session.textContent).toContain("Session tool");
  expect(session.textContent).toContain("provider");
  expect(session.textContent).toContain("openai");
  expect(session.textContent).toContain("openrouter");
});

test("separates info clicks from checkbox selection and keeps one panel open", () => {
  const { changes, container } = mountExpandedPicker();
  const changeCount = changes.length;
  const readButton = infoButton(container, "read");
  const bashButton = infoButton(container, "bash");
  for (const button of [readButton, bashButton]) {
    button.click();
    expect(changes).toHaveLength(changeCount);
  }
  expect(readButton.getAttribute("aria-expanded")).toBe("false");
  expect(bashButton.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelectorAll("[data-tool-detail-panel]")).toHaveLength(
    1,
  );

  bashButton.click();
  expect(bashButton.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-tool-detail-panel]")).toBeNull();
});

test("closes on Escape and outside pointer interaction while restoring focus", async () => {
  const { container } = mountExpandedPicker();
  const button = infoButton(container, "edit");
  openPanel(container, "edit");
  window.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
  );
  await Promise.resolve();

  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button);

  openPanel(container, "edit");
  window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

test("does not close for interaction inside the responsive detail panel", () => {
  const { container } = mountExpandedPicker();
  const panel = openPanel(container, "write");
  panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

  expect(infoButton(container, "write").getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(panel.className).toContain("max-w");
  expect(panel.className).toContain("max-h");
  expect(panel.className).toContain("overflow-y-auto");
  expect(panel.className).toContain("w-full");
});
