import { expect, test } from "vitest";
import { PWA_BACKGROUND_COLOR, PWA_MANIFEST, PWA_THEME_COLOR } from "../pwa.ts";

test("describes Q Mush as a scoped standalone PWA with maskable icons", () => {
  expect(PWA_MANIFEST.name).toBe("Q Mush");
  expect(PWA_MANIFEST.short_name).toBe("Q Mush");
  expect(PWA_MANIFEST.description).toMatch(/local-first/u);
  expect(PWA_MANIFEST.display).toBe("standalone");
  expect(PWA_MANIFEST.id).toBe("/app");
  expect(PWA_MANIFEST.start_url).toBe("/app");
  expect(PWA_MANIFEST.scope).toBe("/");
  expect(PWA_MANIFEST.background_color).toBe(PWA_BACKGROUND_COLOR);
  expect(PWA_MANIFEST.theme_color).toBe(PWA_THEME_COLOR);
  expect(PWA_MANIFEST.icons).toHaveLength(3);
  expect(PWA_MANIFEST.icons.map(({ src }) => src)).toEqual([
    "/icons/q-mush-192.png",
    "/icons/q-mush-512.png",
    "/icons/q-mush-maskable-512.png",
  ]);
  expect(PWA_MANIFEST.icons.at(-1)?.purpose).toBe("maskable");
  expect(
    PWA_MANIFEST.icons.every(({ sizes }) =>
      ["192x192", "512x512"].includes(sizes),
    ),
  ).toBe(true);
  expect(PWA_MANIFEST.icons.map(({ type }) => type)).toEqual([
    "image/png",
    "image/png",
    "image/png",
  ]);
});
