import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { SessionToolUpdateEditor } from "../session-tool-update-client.tsx";
import {
  disposeTestViews,
  mountTestView,
  queryTestElementAs,
} from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const DISPOSALS: (() => void)[] = [];

function clearMountedEditor(): void {
  disposeTestViews(DISPOSALS);
}

afterEach(clearMountedEditor);

test("renders only provider and tool access as compact collapsed rows", () => {
  const { container } = mountTestSessionDetail(TEST_SESSION_DETAIL, DISPOSALS);
  const editorGroup = queryTestElementAs(
    container,
    "[data-session-editor-group='true']",
    HTMLDivElement,
  );
  const rows = [...editorGroup.children];

  expect(rows).toHaveLength(2);
  expect(container.textContent).not.toContain("Spawn child session");
  expect(
    container.querySelector("[data-session-spawn-toggle='true']"),
  ).toBeNull();
  expect(
    rows.map((row) => row.getAttribute("data-session-editor-kind")),
  ).toEqual(["provider", "tools"]);
  for (const row of rows) {
    expect(row.classList).toContain("py-0");
    expect(row.classList).not.toContain("py-1");
    expect(row.classList).not.toContain("py-2");
    expect(row.children).toHaveLength(1);
    const heading = row.firstElementChild;
    expect(heading).toBeInstanceOf(HTMLHeadingElement);
    expect(heading?.classList).toContain("justify-between");
    expect(heading?.classList).toContain("leading-5");
    const toggle = heading?.lastElementChild;
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.classList).toContain("px-1");
    expect(toggle?.classList).toContain("py-0");
    expect(toggle?.classList).not.toContain("border");
    expect(toggle?.classList).toContain("focus-visible:outline-2");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  }
});

function expectToolEditorCollapsed(
  findUpdateButton: () => HTMLButtonElement | undefined,
  findDescription: () => HTMLParagraphElement | undefined,
): void {
  expect(findUpdateButton()).toBeUndefined();
  expect(findDescription()).toBeUndefined();
}

test("shows update access only while the tool picker is expanded", () => {
  const container = mountTestView(
    () => (
      <SessionToolUpdateEditor
        detail={TEST_SESSION_DETAIL}
        disabled={false}
        onApply={() => Promise.resolve({ updated: true, warning: null })}
      />
    ),
    DISPOSALS,
  );
  const toolToggle = queryTestElementAs(
    container,
    "[data-session-tool-toggle='true']",
    HTMLButtonElement,
  );
  const findUpdateButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Update tool access",
    );
  const findDescription = (): HTMLParagraphElement | undefined =>
    [...container.querySelectorAll<HTMLParagraphElement>("p")].find(
      ({ textContent }) =>
        textContent.includes("Changes fence the current execution generation"),
    );

  expect(toolToggle.textContent).toBe("Expand");
  expect(toolToggle.getAttribute("aria-expanded")).toBe("false");
  expect(
    container.querySelector("[data-tool-picker-toggle='true']"),
  ).toBeNull();
  expectToolEditorCollapsed(findUpdateButton, findDescription);

  toolToggle.click();

  expect(toolToggle.textContent).toBe("Collapse");
  expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
  expect(
    container.querySelector("[data-tool-picker-controls='true']"),
  ).toBeInstanceOf(HTMLDivElement);
  expect(findUpdateButton()).toBeInstanceOf(HTMLButtonElement);
  expect(findDescription()).toBeInstanceOf(HTMLParagraphElement);

  toolToggle.click();

  expectToolEditorCollapsed(findUpdateButton, findDescription);
});

test("keeps the tool draft stable across unrelated realtime detail updates", async () => {
  const [detail, setDetail] = createSignal(TEST_SESSION_DETAIL);
  const onApply = vi.fn(() =>
    Promise.resolve({ updated: false, warning: "Confirm the tool change" }),
  );
  const container = mountTestView(
    () => (
      <SessionToolUpdateEditor
        detail={detail()}
        disabled={false}
        onApply={onApply}
      />
    ),
    DISPOSALS,
  );
  await Promise.resolve();

  const toolToggle = queryTestElementAs(
    container,
    "[data-session-tool-toggle='true']",
    HTMLButtonElement,
  );
  toolToggle.click();
  const selectedTool = container.querySelector<HTMLInputElement>(
    "input[value='bash']",
  );
  if (selectedTool === null) {
    throw new Error("The bash tool checkbox was not rendered");
  }
  selectedTool.click();
  selectedTool.focus();

  const updateDetail = (): void => {
    setDetail((current) =>
      Object.assign({}, current, { updatedAt: current.updatedAt + 1 }),
    );
  };
  updateDetail();
  await Promise.resolve();

  expect(
    queryTestElementAs(container, "input[value='bash']", HTMLInputElement),
  ).toBe(selectedTool);
  expect(selectedTool).toMatchObject({ checked: false });
  expect(selectedTool.matches(":focus")).toBe(true);
  expect(
    queryTestElementAs(
      container,
      "[data-session-tool-toggle='true']",
      HTMLButtonElement,
    ).getAttribute("aria-expanded"),
  ).toBe("true");
});
