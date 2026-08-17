import { join } from "node:path";
import { expect, test } from "vitest";
import {
  runBrowserTests,
  type BrowserTestDependencies,
} from "../test-browser-runner.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");

interface SpawnCall {
  readonly command: readonly string[];
  readonly options: Parameters<BrowserTestDependencies["spawn"]>[1];
}

function dependencyProbe(exitCode = 0): {
  readonly calls: SpawnCall[];
  readonly dependencies: BrowserTestDependencies;
} {
  const calls: SpawnCall[] = [];
  const spawn: BrowserTestDependencies["spawn"] = (command, options) => {
    calls.push({ command, options });
    return { exited: Promise.resolve(exitCode) };
  };
  return { calls, dependencies: { spawn } };
}

test("browser launcher forwards filters while disabling inherited Playwright debug mode", async () => {
  const probe = dependencyProbe();
  const originalDebug = process.env["PWDEBUG"];
  process.env["PWDEBUG"] = "1";

  try {
    await expect(
      runBrowserTests(
        ["session-detail", "--browser.headless=false"],
        probe.dependencies,
      ),
    ).resolves.toBe(0);
  } finally {
    process.env["PWDEBUG"] = originalDebug;
  }

  expect(probe.calls).toHaveLength(1);
  expect(probe.calls[0]?.command).toEqual([
    "vitest",
    "run",
    "--config",
    "vitest.browser.config.ts",
    "session-detail",
    "--browser.headless=false",
  ]);
  expect(probe.calls[0]?.options.cwd).toBe(ROOT_DIRECTORY);
  expect(probe.calls[0]?.options.env["PWDEBUG"]).toBe("0");
});

test("browser launcher preserves the child exit code", async () => {
  await expect(
    runBrowserTests([], dependencyProbe(7).dependencies),
  ).resolves.toBe(7);
});
