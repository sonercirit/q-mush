import { expect, test } from "vitest";
import { FAVICON_PATH } from "../../shared/routes.ts";
import { renderAppPage, renderHomePage } from "../../solid/pages.tsx";

test("renders every server page through Solid with favicon metadata", () => {
  const home = renderHomePage();
  const app = renderAppPage();
  const faviconLink = `<link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">`;

  expect(home).toContain(">Q Mush</h1>");
  expect(app).toContain('<main id="app"');
  expect(home).toContain(faviconLink);
  expect(app).toContain(faviconLink);
  expect(home).not.toContain("data-hk=");
  expect(app).not.toContain("data-hk=");
});
