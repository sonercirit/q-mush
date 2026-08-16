import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigFromFile } from "vite";
import { expect, test } from "vitest";
import { isRecord } from "../../shared/validation.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");

function packageScripts(source: string): Map<string, string> {
  const value: unknown = JSON.parse(source);
  const scripts = isRecord(value) ? value["scripts"] : undefined;

  if (!isRecord(scripts)) {
    throw new TypeError("package.json must define string scripts");
  }

  const entries: [string, string][] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      throw new TypeError("package.json must define string scripts");
    }
    entries.push([name, command]);
  }

  return new Map(entries);
}

test("automated Chromium launch paths use the explicitly headless browser config", async () => {
  const [loadedConfig, packageSource, workflowSource] = await Promise.all([
    loadConfigFromFile(
      { command: "serve", mode: "test" },
      join(ROOT_DIRECTORY, "vitest.browser.config.ts"),
      ROOT_DIRECTORY,
      "silent",
    ),
    readFile(join(ROOT_DIRECTORY, "package.json"), "utf8"),
    readFile(join(ROOT_DIRECTORY, ".github/workflows/checks.yml"), "utf8"),
  ]);
  const scripts = packageScripts(packageSource);
  const browser = loadedConfig?.config.test?.browser;

  expect(browser?.headless).toBe(true);
  expect(browser?.instances).toEqual([{ browser: "chromium" }]);
  expect(scripts.get("test:browser")).toBe(
    "vitest run --config vitest.browser.config.ts",
  );
  expect(scripts.get("test")).toContain("bun run test:browser");
  expect(workflowSource).toContain("run: bun run test:browser");
  expect(workflowSource).not.toMatch(
    /test:browser[^\n]*(?:headed|headless=false)/u,
  );
});
