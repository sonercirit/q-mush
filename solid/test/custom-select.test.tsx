import { expect, test } from "vitest";
import { CustomSelect, type CustomSelectOption } from "../custom-select.tsx";
import { customSelectOptions } from "./custom-select-fixtures.ts";
import { renderSolidToString } from "./render-solid.tsx";

function renderSelect(
  selectOptions: readonly CustomSelectOption[],
  selectedValue: string,
  open = true,
): string {
  return renderSolidToString(() => (
    <CustomSelect
      options={selectOptions}
      selectedValue={selectedValue}
      required
      open={open}
      onToggle={() => undefined}
      onChoose={() => undefined}
      name="testChoice"
      label="Test choice"
      id="test-select"
      emptyLabel="No options available"
      disabled={false}
    />
  ));
}

function renderedOptionValues(html: string): readonly string[] {
  return [...html.matchAll(/data-option-value="([^"]*)"/gu)].map(
    (match) => match[1] ?? "",
  );
}

function expectNoEnhancements(html: string): void {
  expect(html).not.toContain("data-custom-select-search");
  expect(html).not.toContain("data-custom-select-page");
}

test("paginates more than ten options and opens on the selected option page", () => {
  const html = renderSelect(customSelectOptions(12), "option-12");

  expect(renderedOptionValues(html)).toEqual(["option-11", "option-12"]);
  expect(html).toContain('data-custom-select-search="testChoice"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-haspopup="listbox"');
  expect(html).toContain('aria-controls="test-select-options"');
  expect(html).toContain(
    'aria-describedby="test-select-search-status test-select-pagination"',
  );
  expect(html).toContain('id="test-select-pagination"');
  expect(html).toContain('data-custom-select-page="testChoice"');
  expect(html).toMatch(/11(?:<!--.*?-->)?–(?:<!--.*?-->)?12/u);
  expect(html).toMatch(/of (?:<!--.*?-->)?12/u);
  expect(html).toContain("options");
  expect(html).toMatch(/Page (?:<!--.*?-->)?2/u);
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain("Description 12");
  expect(html).toContain("12 detail");
  expect(html).toMatch(
    /<input name="testChoice" required type="hidden" value="option-12">/u,
  );
});

test("wraps long labels instead of truncating them", () => {
  const html = renderSelect(
    [
      {
        label:
          "/home/mush/a-very-long-project-directory/with-a-long-option-label",
        value: "long-path",
      },
    ],
    "long-path",
  );

  expect(html).toContain("break-words");
  expect(html).not.toContain('class="block truncate"');
});

test("renders exactly ten options without search or pagination", () => {
  const html = renderSelect(customSelectOptions(10), "option-1");

  expect(renderedOptionValues(html)).toHaveLength(10);
  expectNoEnhancements(html);
  expect(html).not.toMatch(/>Previous<|>Next</u);
});

test("preserves disabled and empty labels without pagination chrome", () => {
  const html = renderSolidToString(() => (
    <CustomSelect
      disabled
      emptyLabel="Loading choices…"
      id="loading-select"
      label="Loading choice"
      name="loadingChoice"
      onChoose={() => undefined}
      onToggle={() => undefined}
      open={false}
      options={[]}
      required={false}
      selectedValue=""
    />
  ));

  expect(html).toContain("Loading choices…");
  expect(html).toMatch(/<button[^>]* disabled[^>]*id="loading-select"/u);
  expectNoEnhancements(html);
});
