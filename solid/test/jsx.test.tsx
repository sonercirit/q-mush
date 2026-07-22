import { expect, test } from "vitest";
import { renderSolidToString } from "./render-solid.tsx";

test("server rendering escapes text and attributes", () => {
  const html = renderSolidToString(() => (
    <p data-label={'Q "Mush"'}>{"Agents < humans & mushrooms"}</p>
  ));

  expect(html).toBe(
    '<p data-label="Q &quot;Mush&quot;">Agents &lt; humans &amp; mushrooms</p>',
  );
});
