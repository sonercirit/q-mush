import { Window } from "happy-dom";
import { expect, test } from "vitest";
import { FAVICON_PATH } from "../../shared/routes.ts";
import { renderAppPage, renderHomePage } from "../../solid/pages.tsx";

function expectFaviconMetadata(html: string, pageUrl: string): void {
  const window = new Window({ url: pageUrl });
  window.document.write(html);
  const faviconLinks = window.document.head.querySelectorAll("link");
  const faviconLink = [...faviconLinks].find(({ relList }) =>
    relList.contains("icon"),
  );

  expect(
    [...faviconLinks].filter(({ relList }) => relList.contains("icon")),
  ).toHaveLength(1);
  expect(faviconLink?.getAttribute("href")).toBe(FAVICON_PATH);
  expect(faviconLink?.getAttribute("type")).toBe("image/svg+xml");
  expect(faviconLink?.href).toBe(`https://q-mush.test${FAVICON_PATH}`);
  expect(
    window.document.body.querySelectorAll('link[rel~="icon"]'),
  ).toHaveLength(0);
}

test("renders every server page through Solid with absolute favicon metadata", () => {
  const home = renderHomePage();
  const app = renderAppPage();

  expect(home).toContain(">Q Mush</h1>");
  expect(app).toContain('<main id="app"');
  expect(home).not.toContain("data-hk=");
  expect(app).not.toContain("data-hk=");
  expectFaviconMetadata(home, "https://q-mush.test/");
  expectFaviconMetadata(app, "https://q-mush.test/app/sessions/session-id");
});
