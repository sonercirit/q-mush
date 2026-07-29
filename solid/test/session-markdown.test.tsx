import { expect, test } from "vitest";
import { renderMarkdown } from "../../solid/session-markdown.tsx";
import { renderSolidToString } from "./render-solid.tsx";

function render(content: string): string {
  return renderSolidToString(() => renderMarkdown(content));
}

test("renders pipe tables with header, body, and column alignment", () => {
  const html = render(`| Worker | Session | State |
| :--- | :-: | ---: |
| R6-A | 019f… | Done |`);

  expect(html).toContain("<table");
  expect(html).toContain("<thead");
  expect(html).toContain("<tbody>");
  expect(html).toContain('class="px-3 py-2 text-left font-semibold');
  expect(html).toContain('class="px-3 py-2 text-center font-semibold');
  expect(html).toContain('class="px-3 py-2 text-right font-semibold');
  expect(html).toContain(">Worker</th>");
  expect(html).toContain(">R6-A</td>");
});

test("renders inline formatting inside table cells", () => {
  const html = render(`Name | Details
--- | ---
**Q Mush** | *fast* and \`safe\``);

  expect(html).toContain("<table");
  expect(html).toContain(">Q Mush</strong>");
  expect(html).toContain(">fast</em>");
  expect(html).toContain(">safe</code>");
});

test("keeps escaped pipes inside a table cell", () => {
  const html = render(`Key | Value
--- | ---
Command | left \\| right`);

  expect(html).toContain("<table");
  expect(html).toContain("left | right</td>");
  expect(html.match(/<td/gu)).toHaveLength(2);
});

test("renders malformed pipe tables as normal paragraph text", () => {
  const html = render(`| Worker | Session |
| R6-A | 019f… |`);

  expect(html).not.toContain("<table");
  expect(html).toContain("| Worker | Session | | R6-A | 019f… |");
});
