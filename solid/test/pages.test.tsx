import { expect, test } from "vitest";
import { renderAppPage, renderHomePage } from "../../solid/pages.tsx";

test("renders every server page through Solid", () => {
  const home = renderHomePage();
  const app = renderAppPage();

  expect(home).toContain(">Q Mush</h1>");
  expect(app).toContain('<main id="app"');
  expect(home).not.toContain("data-hk=");
  expect(app).not.toContain("data-hk=");
});
