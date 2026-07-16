import { expect, test } from "bun:test";
import { createElement, renderToHtml } from "../jsx.ts";

test("server rendering escapes text and attributes", () => {
  const html = renderToHtml(
    <p data-label={'Q "Mush"'}>{"Agents < humans & mushrooms"}</p>,
  );

  expect(html).toBe(
    '<p data-label="Q &quot;Mush&quot;">Agents &lt; humans &amp; mushrooms</p>',
  );
});
