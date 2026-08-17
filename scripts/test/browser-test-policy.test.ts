import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type LaunchOptions } from "playwright";
import { afterEach, expect, test } from "vitest";
import { createVitest, parseCLI } from "vitest/node";
import { isRecord } from "../../shared/validation.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");
const ORIGINAL_PLAYWRIGHT_DEBUG = process.env["PWDEBUG"];

function restorePlaywrightLaunch(): void {
  chromium.launch = ORIGINAL_PLAYWRIGHT_LAUNCH;
}

const ORIGINAL_PLAYWRIGHT_LAUNCH = chromium.launch.bind(chromium);

afterEach(() => {
  restorePlaywrightLaunch();
  process.env["PWDEBUG"] = ORIGINAL_PLAYWRIGHT_DEBUG;
});

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

async function browserLaunchProbe(
  arguments_: readonly string[],
  playwrightDebug: string | undefined,
): Promise<LaunchOptions> {
  const launch = Promise.withResolvers<LaunchOptions>();
  chromium.launch = (options) => {
    launch.resolve(options ?? {});
    return Promise.reject(new Error("Browser launch captured"));
  };
  process.env["PWDEBUG"] = playwrightDebug;

  const parsed = parseCLI([
    "vitest",
    "run",
    "--config",
    "vitest.browser.config.ts",
    ...arguments_,
  ]);
  const vitest = await createVitest("test", parsed.options);

  try {
    const [project] = vitest.projects;
    if (project === undefined) {
      throw new Error("Browser policy probe found no Vitest project");
    }
    const standalone = vitest.standalone();
    await expect(standalone).rejects.toThrow("Browser launch captured");
    expect(project.browser?.provider.name).toBe("playwright");
    expect(project.config.browser.name).toBe("chromium");
    return await launch.promise;
  } finally {
    await vitest.close();
  }
}

test("ordinary Chromium launches stay headless under adversarial overrides", async () => {
  await expect(browserLaunchProbe([], undefined)).resolves.toMatchObject({
    headless: true,
  });
  await expect(
    browserLaunchProbe(["--browser.headless=false"], undefined),
  ).resolves.toMatchObject({ headless: true });
  await expect(browserLaunchProbe([], "1")).resolves.toMatchObject({
    headless: true,
  });
});

test("package and CI structurally use the guarded browser launcher", async () => {
  const [packageSource, workflowSource] = await Promise.all([
    readFile(join(ROOT_DIRECTORY, "package.json"), "utf8"),
    readFile(join(ROOT_DIRECTORY, ".github/workflows/checks.yml"), "utf8"),
  ]);
  const scripts = packageScripts(packageSource);
  const workflow: unknown = Bun.YAML.parse(workflowSource);
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  const tests = isRecord(jobs) ? jobs["tests"] : undefined;
  const steps = isRecord(tests) ? tests["steps"] : undefined;
  const commands = Array.isArray(steps)
    ? steps.flatMap((step) =>
        isRecord(step) && typeof step["run"] === "string" ? [step["run"]] : [],
      )
    : [];

  expect(scripts.get("test:browser")).toBe("bun run scripts/test-browser.ts");
  expect(scripts.get("test")).toBe("bun run test:unit && bun run test:browser");
  expect(commands).toContain("bun run test:browser");
});
