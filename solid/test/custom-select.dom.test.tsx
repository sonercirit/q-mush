import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import { CustomSelect, type CustomSelectOption } from "../custom-select.tsx";
import { customSelectOptions } from "./custom-select-fixtures.ts";

const disposals: (() => void)[] = [];

function query<ElementType extends Element>(
  container: ParentNode,
  selector: string,
  constructor: abstract new (...arguments_: never[]) => ElementType,
): ElementType {
  const element = container.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new TypeError(`Missing test element: ${selector}`);
  }
  return element;
}

function mountSelect(
  initialOptions = customSelectOptions(25),
  initialValue = "option-1",
): {
  readonly choose: ReturnType<typeof vi.fn<(value: string) => void>>;
  readonly container: HTMLDivElement;
  readonly setOpen: (open: boolean) => void;
  readonly setOptions: (options: readonly CustomSelectOption[]) => void;
  readonly setSelected: (value: string) => void;
} {
  const container = document.createElement("div");
  const choose = vi.fn<(value: string) => void>();
  const [open, setOpen] = createSignal(true);
  const [selectOptions, setOptions] = createSignal(initialOptions);
  const [selected, setSelected] = createSignal(initialValue);
  document.body.append(container);
  const view = (): JSX.Element => (
    <CustomSelect
      disabled={false}
      emptyLabel="No options available"
      id="test-select"
      label="Test choice"
      name="testChoice"
      onChoose={(value) => {
        choose(value);
        setSelected(value);
        setOpen(false);
      }}
      onToggle={() => {
        setOpen((value) => !value);
      }}
      open={open()}
      options={selectOptions()}
      required
      selectedValue={selected()}
    />
  );
  disposals.push(render(view, container));
  return { choose, container, setOpen, setOptions, setSelected };
}

function keydown(element: Element, key: string): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

function input(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function optionValues(container: ParentNode): readonly string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-option-value]"),
    (option) => option.dataset["optionValue"] ?? "",
  );
}

function expectedOptionValues(start: number, end: number): readonly string[] {
  return customSelectOptions(25)
    .slice(start, end)
    .map(({ value }) => value);
}

function search(container: ParentNode): HTMLInputElement {
  return query(
    container,
    "[data-custom-select-search='testChoice']",
    HTMLInputElement,
  );
}

function enterSearch(container: ParentNode, value: string): void {
  input(search(container), value);
}

function searchAndNavigate(
  container: ParentNode,
  value: string,
  ...keys: readonly string[]
): HTMLInputElement {
  const searchbox = search(container);
  searchbox.focus();
  enterSearch(container, value);
  for (const key of keys) {
    keydown(searchbox, key);
  }
  return searchbox;
}

function pageButton(
  container: ParentNode,
  direction: "next" | "previous",
): HTMLButtonElement {
  return query(
    container,
    `[data-custom-select-${direction}='testChoice']`,
    HTMLButtonElement,
  );
}

function expectFirstPage(container: ParentNode): void {
  expect([
    optionValues(container),
    container.textContent?.includes("Page 1 of 3") === true,
  ]).toEqual([expectedOptionValues(0, 10), true]);
}

function triggerText(container: ParentNode): string | null {
  return query(container, "#test-select", HTMLButtonElement).textContent;
}

function closeSelect(
  container: ParentNode,
  setOpen: (open: boolean) => void,
): HTMLButtonElement {
  const trigger = query(container, "#test-select", HTMLButtonElement);
  setOpen(false);
  trigger.focus();
  return trigger;
}

function expectActiveDescendant(
  trigger: HTMLButtonElement,
  value: string,
): void {
  expect(trigger.getAttribute("aria-activedescendant")).toBe(
    `test-select-option-${value}`,
  );
}

afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => {
      dispose();
    });
  document.body.textContent = "";
});

test("search is case-insensitive and no-results navigation is inert", () => {
  const mounted = mountSelect();
  searchAndNavigate(mounted.container, "OPTION 2");
  expect(optionValues(mounted.container)).toEqual([
    "option-2",
    "option-20",
    "option-21",
    "option-22",
    "option-23",
    "option-24",
    "option-25",
  ]);
  expect(mounted.container.textContent).toContain("7 results");
  expect(mounted.container.textContent).not.toContain("Page 2");

  searchAndNavigate(mounted.container, "missing", "ArrowDown", "Enter");
  expect(mounted.choose).not.toHaveBeenCalled();
  expect(optionValues(mounted.container)).toHaveLength(0);
  expect(mounted.container.textContent).toContain("No options match “missing”");
  expect(mounted.container.querySelector("[role='option']")).toBeNull();
});

test("matches Unicode labels and metadata without changing stable order", () => {
  const unicodeOptions: readonly CustomSelectOption[] = [
    {
      description: "Crème brûlée",
      detail: "İstanbul",
      label: "Café",
      value: "coffee",
    },
    ...customSelectOptions(10),
  ];
  const { container } = mountSelect(unicodeOptions, "coffee");

  for (const query of ["cafe", "istanbul"]) {
    enterSearch(container, query);
    expect(optionValues(container)).toEqual(["coffee"]);
  }

  enterSearch(container, "option");
  expect(optionValues(container)).toEqual(
    customSelectOptions(10).map(({ value }) => value),
  );
});

test("filters large option sets without mutating their stable order", () => {
  const options = customSelectOptions(5_000);
  const { container } = mountSelect(options, "option-1");

  enterSearch(container, "Option 49");

  expect(optionValues(container)).toEqual(
    options
      .filter(({ label }) => label.includes("Option 49"))
      .slice(0, 10)
      .map(({ value }) => value),
  );
  expect(options[0]?.value).toBe("option-1");
  expect(options.at(-1)?.value).toBe("option-5000");
});

test("resets an open select when options or selection change", () => {
  const { container, setOptions, setSelected } = mountSelect(
    customSelectOptions(25),
    "option-24",
  );

  pageButton(container, "previous").click();
  setSelected("option-3");
  expectFirstPage(container);

  pageButton(container, "next").click();
  setOptions(customSelectOptions(30));
  expectFirstPage(container);
});

test("pages ten options at a time and resets the page when search changes", () => {
  const { container } = mountSelect();

  pageButton(container, "next").click();
  expect(pageButton(container, "next").disabled).toBe(false);
  expect(pageButton(container, "previous").disabled).toBe(false);
  expect(optionValues(container)).toEqual(expectedOptionValues(10, 20));
  expect(container.textContent).toContain("Page 2 of 3");

  enterSearch(container, "Option");
  expect(optionValues(container)).toEqual(expectedOptionValues(0, 10));
  expect(container.textContent).toContain("Page 1 of 3");
});

test("external option and selected-value changes reset to the selected page", () => {
  const { container, setOpen, setOptions, setSelected } = mountSelect(
    customSelectOptions(25),
    "option-24",
  );

  expect(optionValues(container)).toEqual(expectedOptionValues(20, 25));
  expect(container.textContent).toContain("Page 3 of 3");
  pageButton(container, "previous").click();
  expect(container.textContent).toContain("Page 2 of 3");
  expect(triggerText(container)).toContain("Option 24");

  setSelected("option-3");
  expect(container.textContent).toContain("Option 3");
  expect(container.textContent).toContain("Page 1 of 3");
  setOpen(false);
  setOpen(true);
  expect(container.textContent).toContain("Page 1 of 3");

  setOptions(customSelectOptions(5));
  expect(container.textContent).not.toContain("Page 2 of");
  expect(optionValues(container)).toHaveLength(5);
});

test("keeps selected values valid while filtering other pages", () => {
  const { container } = mountSelect(customSelectOptions(25), "option-24");
  const hiddenInput = query(
    container,
    "input[name='testChoice']",
    HTMLInputElement,
  );

  enterSearch(container, "Option 1");

  expect(optionValues(container)).not.toContain("option-24");
  expect(hiddenInput.value).toBe("option-24");
  expect(triggerText(container)).toContain("Option 24");
});

test("supports trigger and listbox keyboard navigation with focus restoration", async () => {
  const { choose, container, setOpen } = mountSelect(
    customSelectOptions(12),
    "option-1",
  );
  const trigger = closeSelect(container, setOpen);
  keydown(trigger, "ArrowDown");
  await Promise.resolve();
  const listbox = query(container, "#test-select-options", HTMLUListElement);
  expect(document.activeElement).toBe(listbox);
  expectActiveDescendant(trigger, "option-1");

  keydown(listbox, "End");
  expect(container.textContent).toContain("Page 2 of 2");
  expectActiveDescendant(trigger, "option-12");
  keydown(listbox, "ArrowUp");
  keydown(listbox, "Enter");
  expect(choose).toHaveBeenCalledWith("option-11");
  await Promise.resolve();
  expect(document.activeElement).toBe(trigger);

  trigger.click();
  await Promise.resolve();
  const reopenedListbox = query(
    container,
    "#test-select-options",
    HTMLUListElement,
  );
  keydown(reopenedListbox, "Home");
  expectActiveDescendant(trigger, "option-1");
  keydown(reopenedListbox, "Escape");
  await Promise.resolve();
  expect(container.querySelector("[role='listbox']")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("keeps search and the listbox reachable in sequential focus order", () => {
  const { container } = mountSelect();

  expect(search(container).tabIndex).toBe(0);
  expect(
    query(container, "#test-select-options", HTMLUListElement).tabIndex,
  ).toBe(0);
});

test("Enter opens the popup and focuses search", async () => {
  const { container, setOpen } = mountSelect();
  const trigger = closeSelect(container, setOpen);
  keydown(trigger, "Enter");
  await Promise.resolve();

  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(search(container));
});

test("search arrows choose the next filtered result", () => {
  const mounted = mountSelect();
  searchAndNavigate(mounted.container, "option 2", "ArrowDown", "Enter");

  expect(mounted.choose).toHaveBeenCalledWith("option-20");
});
