import { expect, test } from "vitest";
import { PWA_BACKGROUND_COLOR, PWA_THEME_COLOR } from "../../shared/pwa.ts";
import { renderAppPage, renderHomePage } from "../../solid/pages.tsx";

function expectPwaHead(html: string): void {
  expect(html).toContain('href="/manifest.webmanifest" rel="manifest"');
  expect(html).toContain('href="/icons/q-mush-192.png" rel="apple-touch-icon"');
  expect(html).toContain('name="application-name" content="Q Mush"');
  expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
  expect(html).toContain(
    'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
  );
  expect(html).toContain(`name="theme-color" content="${PWA_THEME_COLOR}"`);
  expect(html).toContain(
    `name="msapplication-TileColor" content="${PWA_BACKGROUND_COLOR}"`,
  );
}

test("renders every server page through Solid with PWA metadata", () => {
  const home = renderHomePage();
  const app = renderAppPage();

  expect(home).toContain(">Q Mush</h1>");
  expect(app).toContain('<main id="app"');
  expect(home).not.toContain("data-hk=");
  expect(app).not.toContain("data-hk=");
  expectPwaHead(home);
  expectPwaHead(app);
});
