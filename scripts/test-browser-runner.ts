import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_LAUNCH_REPORT = "Q_MUSH_BROWSER_LAUNCH_REPORT";

interface BrowserTestProcess {
  readonly exited: Promise<number>;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface BrowserTestDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
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
  executable: process.env["Q_MUSH_BROWSER_EXECUTABLE"] ?? process.execPath,
  spawn: (command, options) => Bun.spawn([...command], options),
};

function headlessEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...base,
    PWDEBUG: "0",
  };
  Reflect.deleteProperty(environment, BROWSER_LAUNCH_REPORT);
  return environment;
}

export async function runBrowserTests(
  arguments_: readonly string[],
  dependencies: BrowserTestDependencies = defaultDependencies,
): Promise<number> {
  if (
    arguments_.some(
      (argument) =>
        argument === "--config" ||
        argument.startsWith("--config=") ||
        argument === "-c" ||
        argument.startsWith("-c="),
    )
  ) {
    throw new Error("Browser tests do not accept Vitest config overrides");
  }
  const browserTests = dependencies.spawn(
    [
      dependencies.executable,
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
      env: headlessEnvironment(dependencies.environment),
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    },
  );

  const forwardSignal = (signal: NodeJS.Signals): void => {
    browserTests.kill(signal);
  };
  const forwardInterrupt = (): void => {
    forwardSignal("SIGINT");
  };
  const forwardTermination = (): void => {
    forwardSignal("SIGTERM");
  };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    const exitCode = await browserTests.exited;
    return browserTests.signalCode ? 1 : exitCode;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }
}
