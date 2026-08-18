import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface BrowserTestProcess {
  readonly exited: Promise<number>;
}

export interface BrowserTestDependencies {
  readonly spawn: (
    command: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly stderr: "inherit";
      readonly stdin: "inherit";
      readonly stdout: "inherit";
    },
  ) => BrowserTestProcess;
}

const defaultDependencies: BrowserTestDependencies = {
  // PATH resolution is intentional: compatibility probes replace Bun while
  // still exercising this shipped runner.
  spawn: (command, options) => Bun.spawn([...command], options),
};

function headlessEnvironment(): Record<string, string | undefined> {
  return { ...process.env, PWDEBUG: "0" };
}

export async function runBrowserTests(
  arguments_: readonly string[],
  dependencies: BrowserTestDependencies = defaultDependencies,
): Promise<number> {
  const browserTests = dependencies.spawn(
    [
      "bun",
      "--no-orphans",
      "run",
      "--bun",
      "vitest",
      "run",
      "--config",
      "vitest.browser.config.ts",
      ...arguments_,
    ],
    {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      env: headlessEnvironment(),
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    },
  );

  return browserTests.exited;
}
